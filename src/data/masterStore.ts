import type {
  SkillMasterData,
  SkillMasterItem,
  PlayableCardItem,
  ScenarioItem,
  CharaEvolutionItem,
  ScenarioEvolutionItem,
  SuccessionEvolutionItem,
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

  public async load(url = '/data/skill_master.json'): Promise<SkillMasterData> {
    if (this.data) return this.data;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load skill master: ${res.statusText}`);
    }
    const data: SkillMasterData = await res.json();
    this.init(data);
    return data;
  }

  public init(data: SkillMasterData): void {
    this.data = data;
    this.skillsById.clear();
    this.skillsByGroupId.clear();
    this.charaEvolutionsByCardId.clear();
    this.scenarioEvolutionsByScenarioId.clear();
    this.successionEvolutionsByBaseSkillId.clear();
    this.cardsById.clear();
    this.scenariosById.clear();

    for (const skill of data.skills) {
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
  }

  /**
   * 金スキル（rarity === 2）が育成ウマ娘（覚醒Lv以内）またはシナリオの進化対象であるか、
   * 継承固有スキル（rarity === 1）が進化可能ラベル付きで継承進化対象であるかを判定
   */
  public isSkillEvolvable(
    skillId: number,
    cardId?: number,
    scenarioId?: number,
    hasEvoBadge = true,
    awakeningLevel = 7
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

    // キャラ進化チェック (育成ウマ娘が選択されている場合のみ、覚醒Lv上限内)
    if (cardId !== undefined && cardId > 0) {
      const charaEvos = this.charaEvolutionsByCardId.get(cardId);
      if (charaEvos && charaEvos.some((e) => e.baseSkillId === skillId && e.slotRank <= awakeningLevel)) {
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
