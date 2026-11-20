import type { DetectedSkillItem, AptitudeState } from './recognition.ts';
import type { SkillMasterItem } from './master.ts';
import type { SkillTestScoreBreakdown, SkillTestSolveConfig } from './skillTest.ts';

export type SolverMode = 'grade' | 'skillTest';

export interface SolverOptions {
  availableSp: number;
  aptitudes: AptitudeState;
  selectedCardId?: number; // 育成ウマ娘
  selectedScenarioId?: number; // シナリオ
  lockedSkillIds: number[]; // 必須取得
  excludedSkillIds: number[]; // 除外
  /** 'grade'（既定, 評価点最大化） | 'skillTest'（技能試験スコア最大化） */
  mode?: SolverMode;
  /** mode === 'skillTest' のとき必須 */
  skillTest?: SkillTestSolveConfig;
}

export interface RecommendedSkill {
  skill: DetectedSkillItem;
  effectiveCost: number; // 実際に追加で支払うSP（下位スキル所持時は差額）
  effectiveGrade: number; // 実際に追加で得られる評価点（下位スキル所持時は差分）
  /** 技能試験モード時: スキル獲得ボーナスの増分（系統の最上位ティア基準） */
  bonusPoints?: number;
  /** 技能試験モード時: スコア増分 = courseMultiplier * effectiveGrade + bonusPoints */
  scoreGain?: number;
  costPerformance: number; // pt / SP
  reason?: string;
}

export interface EvolutionRecommendation {
  slotType: 'chara_lv3' | 'chara_lv5' | 'scenario' | 'succession';
  slotName: string;
  baseSkillName: string;
  baseSkillId: number;
  evolvedSkill?: SkillMasterItem;
  canEvolve: boolean; // 進化条件達成
  /** 技能試験モード時: 進化で増えるスコア（評価点差分×課程倍率 + ボーナス差分） */
  scoreDelta?: number;
  recommendationNote: string; // どの分岐を選ぶべきか、または適性Gで見送るべきか
}

export interface SolverResult {
  maxGradeValue: number; // 最大到達評価点（現在獲得済＋推奨スキルの合計増加）
  totalAdditionalGrade: number; // 増加評価点 (+XXXX pt)
  spentSp: number; // 推奨スキル群の消費SP合計
  remainingSp: number; // 余りSP (所持SP - 消費SP)
  recommendedSkills: RecommendedSkill[]; // 今すぐ [+] を押すべきスキル一覧
  evolutionRecommendations: EvolutionRecommendation[]; // 進化選択ガイド
  /** 技能試験モード時のみ: 現在＋推奨ぶんのスコア内訳 */
  scoreBreakdown?: SkillTestScoreBreakdown;
  /** 技能試験モード時のみ: スキル獲得ボーナス合計（現在獲得済＋推奨） */
  skillBonusTotal?: number;
}
