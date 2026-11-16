import type { DetectedSkillItem, AptitudeState } from './recognition.ts';
import type { SkillMasterItem } from './master.ts';

export interface SolverOptions {
  availableSp: number;
  aptitudes: AptitudeState;
  selectedCardId?: number; // 育成ウマ娘
  selectedScenarioId?: number; // シナリオ
  lockedSkillIds: number[]; // 必須取得
  excludedSkillIds: number[]; // 除外
}

export interface RecommendedSkill {
  skill: DetectedSkillItem;
  effectiveCost: number; // 実際に追加で支払うSP（下位スキル所持時は差額）
  effectiveGrade: number; // 実際に追加で得られる評価点（下位スキル所持時は差分）
  costPerformance: number; // pt / SP
  reason?: string;
}

export interface EvolutionRecommendation {
  slotType: 'chara_lv3' | 'chara_lv5' | 'scenario';
  slotName: string;
  baseSkillName: string;
  baseSkillId: number;
  evolvedSkill?: SkillMasterItem;
  canEvolve: boolean; // 進化条件達成
  recommendationNote: string; // どの分岐を選ぶべきか、または適性Gで見送るべきか
}

export interface SolverResult {
  maxGradeValue: number; // 最大到達評価点（現在獲得済＋推奨スキルの合計増加）
  totalAdditionalGrade: number; // 増加評価点 (+XXXX pt)
  spentSp: number; // 推奨スキル群の消費SP合計
  remainingSp: number; // 余りSP (所持SP - 消費SP)
  recommendedSkills: RecommendedSkill[]; // 今すぐ [+] を押すべきスキル一覧
  evolutionRecommendations: EvolutionRecommendation[]; // 進化選択ガイド
}
