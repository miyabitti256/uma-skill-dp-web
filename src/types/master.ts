export interface SkillConditionRequirement {
  mask: number; // 条件タグビットマスク
  count: number; // 必要所持スキル数
}

export interface SkillMasterItem {
  id: number;
  name: string;
  rarity: number; // 1: ノーマル(白), 2: レア(金), 3..5: 固有, 6: 進化
  groupId: number;
  groupRate: number; // 1: 下位, 2: 上位 等
  gradeValue: number; // 評価点
  needSkillPoint: number; // 定価SP
  distanceTypes: number[]; // 1:短距離, 2:マイル, 3:中距離, 4:長距離
  runningStyles: number[]; // 1:逃げ, 2:先行, 3:差し, 4:追込
  conditionMask?: number; // 進化条件判定用16bit条件マスク
}

export interface CharaEvolutionItem {
  cardId: number;
  slotRank: number; // 3: 覚醒Lv3, 5: 覚醒Lv5, 7: 覚醒Lv7
  baseSkillId: number;
  evolvedSkillId: number;
  requiredSkillConditions?: SkillConditionRequirement[][];
}

export interface ScenarioItem {
  id: number;
  name: string;
  skillUpgradeNum: number;
}

export interface ScenarioEvolutionItem {
  scenarioId: number;
  baseSkillId: number;
  evolvedSkillId: number;
  requiredSkillConditions?: SkillConditionRequirement[][];
}

export interface SuccessionEvolutionItem {
  upgradeId?: number;
  cardId: number; // 継承元ウマ娘カードID（親として設定）
  baseSkillId: number;
  evolvedSkillId: number;
}

export interface PlayableCardItem {
  cardId: number;
  cardTitle: string;
  charaName: string;
  uniqueSkillId: number;
}

export interface SkillMasterData {
  skills: SkillMasterItem[];
  charaEvolutions: CharaEvolutionItem[];
  scenarios: ScenarioItem[];
  scenarioEvolutions: ScenarioEvolutionItem[];
  successionEvolutions?: SuccessionEvolutionItem[];
  cards: PlayableCardItem[];
}
