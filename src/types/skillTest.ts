import type { AptitudeRank } from './recognition.ts';

/**
 * スキル獲得ボーナス（技能試験）
 * 系統（同一 groupId）ごとに最上位1個だけが加算される
 */
export interface SkillBonusTable {
  normal: number; // ノーマル(白・緑) +400
  rare: number; // レア(金) +1,200
  evolved: number; // 進化 +1,500
}

export type StatKey = 'speed' | 'stamina' | 'power' | 'guts' | 'wisdom';

/** 基礎能力ボーナス（ステータス基準の加点。スキル選択とは独立） */
export interface StatBonusRule {
  stat: StatKey | 'any';
  threshold: number;
  points: number;
}

export type SkillTestAptitudeAxis =
  | { kind: 'none' }
  | { kind: 'distance'; distance: 'short' | 'mile' | 'middle' | 'long' }
  | { kind: 'surface'; surface: 'turf' | 'dirt' }
  | { kind: 'style'; style: 'nige' | 'senkou' | 'sashi' | 'oikomi' };

/** 課程ごとの対象ボーナススキル（スキル名で保持し、ロード時にIDへ解決する） */
export interface SkillTestBonusSkillList {
  normal: string[];
  rare: string[];
}

export interface SkillTestThresholds {
  ka: number | null;
  ryo: number | null;
  yu: number | null;
}

export interface SkillTestCourseDef {
  id: string;
  name: string;
  aptitudeAxis: SkillTestAptitudeAxis;
  /** 課題適性ランク別の課程倍率。軸なし(none)は常に1.0 */
  courseMultiplierByRank?: Partial<Record<AptitudeRank, number>>;
  /** null = 指定なし = 全スキーが対象（フリー課程） */
  bonusSkills: SkillTestBonusSkillList | null;
  thresholds: SkillTestThresholds;
}

export interface SkillTestEditionDef {
  id: string;
  name: string;
  scenarioId?: number;
  skillBonus: SkillBonusTable;
  /** 基礎能力ボーナス規則（v1 では未使用のため任意項目。将来のステータス入力用） */
  statBonuses?: StatBonusRule[];
  courses: SkillTestCourseDef[];
}

export interface SkillTestDataFile {
  editions: SkillTestEditionDef[];
}

/** Solver が受け取る、課程ぶんの解決済み設定 */
export interface SkillTestSolveConfig {
  /** 課程倍率（評価点にのみ乗算、ボーナスには乗らない）。フリー = 1.0 */
  courseMultiplier: number;
  skillBonus: SkillBonusTable;
  /** ボーナス対象スキルID。null = 全スキー対象（フリー/エクストラ） */
  bonusSkillIds: ReadonlySet<number> | null;
}

export type StatValues = Record<StatKey, number>;

export interface SkillTestScoreBreakdown {
  /** 評価点 × 課程倍率 */
  gradeValue: number;
  /** スキル獲得ボーナス合計 */
  skillBonus: number;
  /** 基礎能力ボーナス合計 */
  statBonus: number;
  /** レース勝利ボーナス合計 */
  raceBonus: number;
  /** シナリオボーナス合計 */
  scenarioBonus: number;
  total: number;
}

export type SkillTestCourseId = string;
export type SkillTestEditionId = string;
