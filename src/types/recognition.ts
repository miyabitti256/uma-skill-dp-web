export type AptitudeRank = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface AptitudeState {
  turf: AptitudeRank; // 芝
  dirt: AptitudeRank; // ダート
  short: AptitudeRank; // 短距離
  mile: AptitudeRank; // マイル
  middle: AptitudeRank; // 中距離
  long: AptitudeRank; // 長距離
  nige: AptitudeRank; // 逃げ
  senkou: AptitudeRank; // 先行
  sashi: AptitudeRank; // 差し
  oikomi: AptitudeRank; // 追込
}

export type ScreenMode = 'idle' | 'normal' | 'compact' | 'chara_detail';

export type SkillState = 'unselected' | 'selected' | 'acquired';

export interface DetectedSkillItem {
  id: number;
  name: string;
  recognizedCost: number; // 認識された消費SP（ヒントLv反映済み）
  baseCost: number; // 定価SP
  gradeValue: number; // 評価点
  rarity: number; // 1: 白, 2: 金, 3..5: 固有, 6: 進化
  groupId: number;
  groupRate: number;
  state: SkillState; // 未選択, 選択中, 獲得済
  isLocked: boolean; // 必須取得ロック
  isExcluded: boolean; // 除外
  canEvolve: boolean; // 進化条件達成
  lastSeenTimestamp: number;
  firstSeenOrder?: number; // 画面上で認識・確定された順序番号
}
