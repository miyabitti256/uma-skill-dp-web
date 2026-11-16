import type {
  SkillMasterData,
  SkillMasterItem,
  PlayableCardItem,
  ScenarioItem,
  CharaEvolutionItem,
  ScenarioEvolutionItem,
} from '../types/master.ts';

export class MasterStore {
  private static instance: MasterStore | null = null;
  public data: SkillMasterData | null = null;
  public skillsById = new Map<number, SkillMasterItem>();
  public skillsByGroupId = new Map<number, SkillMasterItem[]>();
  public charaEvolutionsByCardId = new Map<number, CharaEvolutionItem[]>();
  public scenarioEvolutionsByScenarioId = new Map<number, ScenarioEvolutionItem[]>();
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
  }

  /**
   * 金スキル（rarity === 2）が育成ウマ娘またはシナリオの進化対象であるかを判定
   */
  public isSkillEvolvable(skillId: number, cardId?: number, scenarioId?: number): boolean {
    const skill = this.skillsById.get(skillId);
    if (!skill || skill.rarity !== 2) return false;
    if (!this.data) return false;

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
