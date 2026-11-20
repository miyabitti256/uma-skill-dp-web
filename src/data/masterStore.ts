import type {
  SkillMasterData,
  SkillMasterItem,
  PlayableCardItem,
  ScenarioItem,
  CharaEvolutionItem,
  ScenarioEvolutionItem,
  SuccessionEvolutionItem,
  SkillAptitudeOverrides,
} from '../types/master.ts';

export class MasterStore {
  private static instance: MasterStore | null = null;
  public data: SkillMasterData | null = null;
  public skillsById = new Map<number, SkillMasterItem>();
  public skillsByGroupId = new Map<number, SkillMasterItem[]>();
  public charaEvolutionsByCardId = new Map<number, CharaEvolutionItem[]>();
  public scenarioEvolutionsByScenarioId = new Map<number, ScenarioEvolutionItem[]>();
  public successionEvolutionsByBaseSkillId = new Map<number, SuccessionEvolutionItem[]>();
  public cardsById = new Map<number, PlayableCardItem>();
  public scenariosById = new Map<number, ScenarioItem>();

  /** 適性条件の補完データ（load 時に取得。init 直後でも適用できるよう保持する） */
  private pendingOverrides: SkillAptitudeOverrides | null = null;

  constructor(data?: SkillMasterData) {
    if (data) {
      this.init(data);
    }
  }

  public static getInstance(): MasterStore {
    if (!MasterStore.instance) {
      MasterStore.instance = new MasterStore();
    }
    return MasterStore.instance;
  }

  /**
   * マスタデータ本体と、説明文由来の適性条件の補完データを読み込む。
   * 補完データは無くても動作に支障が無いため、取得失敗時は警告のみで継続する。
   */
  public async load(
    url = '/data/skill_master.json',
    overridesUrl = '/data/skill_aptitude_overrides.json'
  ): Promise<SkillMasterData> {
    if (this.data) return this.data;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load skill master: ${res.statusText}`);
    }
    const data: SkillMasterData = await res.json();
    this.init(data);

    try {
      const ores = await fetch(overridesUrl);
      if (ores.ok) {
        this.applyAptitudeOverrides((await ores.json()) as SkillAptitudeOverrides);
      } else {
        console.warn(`[MasterStore] Aptitude overrides not found: ${ores.statusText}`);
      }
    } catch (err) {
      console.warn('[MasterStore] Failed to load aptitude overrides:', err);
    }

    return this.data ?? data;
  }

  public init(data: SkillMasterData): void {
    this.data = data;
    this.charaEvolutionsByCardId.clear();
    this.scenarioEvolutionsByScenarioId.clear();
    this.successionEvolutionsByBaseSkillId.clear();
    this.cardsById.clear();
    this.scenariosById.clear();

    this.rebuildSkillMaps();

    for (const card of data.cards) {
      this.cardsById.set(card.cardId, card);
    }

    for (const scenario of data.scenarios) {
      this.scenariosById.set(scenario.id, scenario);
    }

    for (const evo of data.charaEvolutions) {
      const list = this.charaEvolutionsByCardId.get(evo.cardId) || [];
      list.push(evo);
      this.charaEvolutionsByCardId.set(evo.cardId, list);
    }

    for (const evo of data.scenarioEvolutions) {
      const list = this.scenarioEvolutionsByScenarioId.get(evo.scenarioId) || [];
      list.push(evo);
      this.scenarioEvolutionsByScenarioId.set(evo.scenarioId, list);
    }

    for (const evo of data.successionEvolutions ?? []) {
      const list = this.successionEvolutionsByBaseSkillId.get(evo.baseSkillId) || [];
      list.push(evo);
      this.successionEvolutionsByBaseSkillId.set(evo.baseSkillId, list);
    }

    // 補完データが先に渡されている場合はここで適用する
    if (this.pendingOverrides) {
      this.applyAptitudeOverrides(this.pendingOverrides);
    }
  }

  /**
   * 説明文にしか適性条件が無いスキルへ、距離・脚質条件を補完する。
   * マスタ側に既に値がある場合は上書きしない（マスタ優先）。
   * 何度呼んでも同じ結果になる（冪等）。
   */
  public applyAptitudeOverrides(overrides: SkillAptitudeOverrides): void {
    this.pendingOverrides = overrides;
    if (!this.data) return;

    // 未知のIDや注記キーは無視する（"_" 始まりは注記）
    for (const key of Object.keys(overrides)) {
      if (key.startsWith('_')) continue;
      if (!this.skillsById.has(Number(key))) {
        console.warn(`[MasterStore] Aptitude override for unknown skill id: ${key}`);
      }
    }

    let changed = false;
    const skills = this.data.skills.map((skill) => {
      const override = overrides[String(skill.id)];
      if (!override) return skill;

      // マスタに値があるなら尊重し、空のときだけ補完する
      const distanceTypes =
        skill.distanceTypes.length > 0
          ? skill.distanceTypes
          : (override.distanceTypes ?? skill.distanceTypes);
      const runningStyles =
        skill.runningStyles.length > 0
          ? skill.runningStyles
          : (override.runningStyles ?? skill.runningStyles);

      if (distanceTypes === skill.distanceTypes && runningStyles === skill.runningStyles) {
        return skill;
      }
      changed = true;
      return { ...skill, distanceTypes, runningStyles };
    });

    if (!changed) return;
    this.data = { ...this.data, skills };
    this.rebuildSkillMaps();
  }

  /** skillsById / skillsByGroupId を this.data から作り直す */
  private rebuildSkillMaps(): void {
    this.skillsById.clear();
    this.skillsByGroupId.clear();

    if (!this.data) return;

    for (const skill of this.data.skills) {
      this.skillsById.set(skill.id, skill);

      if (skill.groupId > 0) {
        const list = this.skillsByGroupId.get(skill.groupId) || [];
        list.push(skill);
        this.skillsByGroupId.set(skill.groupId, list);
      }
    }

    for (const list of this.skillsByGroupId.values()) {
      list.sort((a, b) => a.groupRate - b.groupRate);
    }
  }

  /**
   * 金スキル（rarity === 2）が育成ウマ娘またはシナリオの進化対象であるか、
   * 継承固有スキル（rarity === 1）が進化可能ラベル付きで継承進化対象であるかを判定
   */
  public isSkillEvolvable(
    skillId: number,
    cardId?: number,
    scenarioId?: number,
    hasEvoBadge = true
  ): boolean {
    const skill = this.skillsById.get(skillId);
    if (!skill || !this.data) return false;

    // 継承進化チェック (対象となる継承固有スキル: rarity === 1 かつ実機画面上で進化条件達成/進化可能ラベルが表示されていること)
    if (skill.rarity === 1) {
      if (!hasEvoBadge) return false;
      const succEvos = this.successionEvolutionsByBaseSkillId.get(skillId);
      if (!succEvos || succEvos.length === 0) return false;
      // 継承元ウマ娘本人を選択している場合は自身の固有スキルを継承できないため除外
      if (cardId !== undefined && cardId > 0) {
        return succEvos.some((e) => e.cardId !== cardId);
      }
      return true;
    }

    if (skill.rarity !== 2) return false;

    // キャラ進化チェック (育成ウマ娘が選択されている場合のみ)
    if (cardId !== undefined && cardId > 0) {
      const charaEvos = this.charaEvolutionsByCardId.get(cardId);
      if (charaEvos && charaEvos.some((e) => e.baseSkillId === skillId)) {
        return true;
      }
    }

    // シナリオ進化チェック (育成シナリオが選択されている場合のみ)
    if (scenarioId !== undefined && scenarioId > 0) {
      const scenarioEvos = this.scenarioEvolutionsByScenarioId.get(scenarioId);
      if (scenarioEvos && scenarioEvos.some((e) => e.baseSkillId === skillId)) {
        return true;
      }
    }

    return false;
  }
}
