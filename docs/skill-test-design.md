# 技能試験スコア最大化モード 実装設計書

対象リポジトリ: `uma-skill-dp-web`
版: v1（フリー課程のみ）

- ゲーム側のルール（何がどう採点されるか）→ [skill-test-spec.md](./skill-test-spec.md)（仕様書・調査メモ）
- 本ドキュメント → **設計書**（どう実装するか：変更ファイル・計算式・UI・テスト・受け入れ条件）

---

## 0. 決定事項（ヒアリング結果）

| 項目 | 決定 |
|---|---|
| 対象課程 | **フリー課程のみ** |
| ステータス5値入力 | **なし**（基礎能力ボーナスは計算しない） |
| 「優」ライン到達判定 | **なし**（スコア表示のみ） |
| ボーナス値・課程定義 | **JSON 外出し**（イベント回ごとに差し替え可能） |
| レース勝利・シナリオボーナス | **v1 では除外**（定数項でスキル選択に影響しない） |

---

## 1. スコープ

### やること
- フリー課程のスコアを最大化する**スキル取得順序（推奨リスト）**を既存DPで厳密に求める
- スコアと**内訳（評価点 / スキル獲得ボーナス）**を表示する
- 既存の「評価点最大化」モードを**完全に維持**し、トグルで切替できるようにする

### やらないこと（v1）
- 距離課程／エクストラ課程の**指定ボーナススキル**（＋400が7件/＋1,200が7件のリスト）
- 課程倍率（フリーは 1.0 固定なので不要）
- 基礎能力ボーナス（ステータス入力）
- レース勝利ボーナス・シナリオボーナス
- 「優」ライン到達判定、目標スコアからの逆算

---

## 2. スコア計算式（実装する仕様）

```
スコア = 評価点 + スキル獲得ボーナス        （フリー課程なので課程倍率 = 1.0）
```

### 2.1 評価点
既存実装と完全に同一。**新しい計算を一切入れない**。

```
スキル評価点 = Math.round(gradeValue × 距離適性倍率 × 脚質適性倍率)
評価点      = Σ スキル評価点 + Σ 固有スキル評価点 + ステータス評価点
```

- 既存関数 `calculateEffectiveGradeValue()` をそのまま使用（芝/ダート無補正、複数条件の最大/乗算も既存のまま）
- 固有スキル・ステータス評価点は「現在の評価点」の一部として扱い、**スキル選択による増分計算には登場しない**（既存と同じ）

### 2.2 スキル獲得ボーナス

```
スキル獲得ボーナス = Σ_{系統 g} tierBonus(系統 g で選ばれた最上位スキル)
```

| スキル種別 | 判定（master データ） | 加点 |
|---|---|---|
| ノーマル（白・**緑**） | `rarity === 1` | **+400** |
| レア（金） | `rarity === 2` | **+1,200** |
| 進化 | `rarity === 6` | **+1,500** |
| 固有 | `rarity === 3,4,5` | 0 |
| マイナス効果（デバフ） | `gradeValue < 0` または `groupRate <= 0` | 0 |

- **系統 = `groupId`**。1系統につき最上位1個のみ加算（既存DPの「1グループ1選択」制約と同一）
- ボーナスは**フラット加算**。適性倍率・課程倍率は乗らない
- **継承固有は rarity 1 → +400**、**継承進化は rarity 6 → +1,500**（データ上もその通りなので追加処理不要）
- 進化後は**別スキルID**になるため、ボーナスは進化後IDの rarity で判定する（フリーは全スキー対象なので結果は常に +1,500）
- デバフ（`groupRate <= 0`）は既存コードで候補から除外済み

---

## 3. 増分の考え方（DPに載せる値）

系統 `g` に既取得スキルがある場合を `base` として、**差分だけ**をDPの重みにする。

| 遷移 | Δ評価点 | Δボーナス | 備考 |
|---|---|---|---|
| 未取得 → 白 | `+評価点(白)` | **+400** | |
| 未取得 → 金 | `+評価点(金)` | **+1,200** | |
| 白 → 金（同一系統） | `評価点(金) − 評価点(白)` | **+800** | 白の400は消える |
| ○ → ◎（同一系統・どちらも白） | `評価点(◎) − 評価点(○)` | **0** | ◎を取る意味は評価点純増のみ |
| 金 → 進化 | `評価点(進化) − 評価点(金)` | **+300** | 1,200 が消えて 1,500 |
| 継承固有(白) → 継承進化 | `評価点(進化) − 評価点(継承固有)` | **+1,100** | 400 が消えて 1,500 |

**DPのオプション価値**

```
value = 1.0 × Δ評価点 + Δボーナス        （= courseMultiplier × Δ評価点 + Δボーナス）
```

`courseMultiplier` はフリー固定で 1.0。係数を残しておくのは将来の距離課程対応のため。

---

## 4. ソルバの変更設計

### 変更対象
`src/solver/skillSolver.ts` の1ファイルのみ（`solverAdapter.ts` は変更不要）

### 4.1 追加する状態

```ts
DpOption {
  ...既存フィールド,
  bonusPoints: number;   // このオプションで増えるスキル獲得ボーナス
  scoreValue: number;    // courseMultiplier * effectiveGrade + bonusPoints
}
```

### 4.2 追加するヘルパ

```ts
// rarity → ボーナス基礎値
tierBonus(rarity: number): number

// スキル1個のボーナス（ボーナス対象フィルタ適用後）
bonusPointsOf(skillId: number, rarity: number): number
  // skillTest 無効時は常に 0
  // bonusSkillIds === null（フリー）→ tierBonus(rarity)
  // それ以外 → bonusSkillIds.has(skillId) ? tierBonus(rarity) : 0
```

### 4.3 差分計算

1. **系統の基準ボーナス** `baseGroupBonus`: 既取得/選択中スキルがあれば `bonusPointsOf(そのID, そのrarity)`、無ければ 0
2. **通常オプション**: `bonus = bonusPointsOf(skill.id, skill.rarity) - baseGroupBonus`
3. **進化オプション**（`evoDetail` あり）: `bonus = bonusPointsOf(evoDetail.evolvedSkill.id, 6) - baseGroupBonus`
4. **既取得グループの進化**（`isAcquiredGroup`）: `bonus = bonusPointsOf(evolvedId, 6) - bonusPointsOf(baseSkillId, baseRarity)`

### 4.4 DP本体

既存の12状態DP（`c3 ∈ {0,1}` × `c5 ∈ {0,1}` × `sc ∈ {0..maxScen}`）の **`gain` を `opt.scoreValue` に差し替えるだけ**。

```diff
- const gain = opt.effectiveGrade;
+ const gain = opt.scoreValue;
```

次元・配列・バックトラック構造・枝刈りは**一切変更しない**（厳密最適のまま）。

### 4.5 集計・返却

| 返却値 | 内容 |
|---|---|
| `maxGradeValue` | 既存通り**評価点**の総計（互換維持） |
| `totalAdditionalGrade` | 既存通り**評価点**の増分 |
| `spentSp` / `remainingSp` | 既存通り |
| `recommendedSkills[].effectiveGrade` | Δ評価点（既存） |
| `recommendedSkills[].bonusPoints` | **新規**: Δボーナス |
| `recommendedSkills[].scoreGain` | **新規**: `scoreValue` |
| `recommendedSkills[].costPerformance` | skillTest 時は `scoreValue / cost`（小数2桁、cost=0 は 999） |
| `skillBonusTotal` | **新規**: 現在取得済み分 + 推奨分 + 既取得進化分 |
| `scoreBreakdown` | **新規**: `{ gradeValue: 1.0×maxGradeValue, skillBonus: skillBonusTotal, statBonus: 0, raceBonus: 0, scenarioBonus: 0, total: gradeValue + skillBonus }` |
| `evolutionRecommendations[].scoreDelta` | **新規**: `Δ評価点 + Δボーナス` |

### 4.6 後方互換の絶対条件

- `options.mode` 未指定 or `'grade'` → **既存コードパスと数値が完全一致**（`scoreValue === effectiveGrade`、`bonusPoints === 0`）
- `mode === 'skillTest'` かつ `options.skillTest` 未定義 → `'grade'` にフォールバック
- 既存テスト36件が無修正で全pass

---

## 5. データ設計

### 5.1 新規ファイル `public/data/skill_test_courses.json`

v1 は**フリー課程1件のみ**を収録（他課程のリストは未検証のため載せない）。

```json
{
  "editions": [
    {
      "id": "2026-10",
      "name": "駿大祭編",
      "scenarioId": 15,
      "skillBonus": { "normal": 400, "rare": 1200, "evolved": 1500 },
      "courses": [
        {
          "id": "free",
          "name": "フリー課程",
          "aptitudeAxis": { "kind": "none" },
          "bonusSkills": null,
          "thresholds": { "ka": null, "ryo": null, "yu": null }
        }
      ]
    }
  ]
}
```

- `bonusSkills: null` = **指定なし = 全スキーがボーナス対象**（フリー課程の定義）
- `thresholds` は将来用に枠だけ確保（v1 では表示しない）
- 他の課程（短距離〜エクストラ）の指定リストは、実装する回に追加する（調査メモに現行リストを記載済み）

### 5.2 新規ファイル `src/data/skillTestStore.ts`

```ts
export class SkillTestStore {
  static getInstance(): SkillTestStore;
  data: SkillTestDataFile | null;
  load(url?: string): Promise<SkillTestDataFile>;   // 既定 '/data/skill_test_courses.json'
  init(data: SkillTestDataFile): void;
  get editions(): SkillTestEditionDef[];
  getEdition(id: string): SkillTestEditionDef | undefined;
  getCourse(editionId: string, courseId: string): SkillTestCourseDef | undefined;
  /** フリー課程の解決済み設定 */
  getSolveConfig(editionId: string, courseId: string): SkillTestSolveConfig;
  ```
- `getSolveConfig` は `{ courseMultiplier: 1.0, skillBonus: edition.skillBonus, bonusSkillIds: null }` を返す
- 未ロード時は例外を投げず安全側（`undefined` / 既定値）
- v1 ではスキル名→ID解決は不要（フリーは全対象）なので実装しない。距離課程対応時に追加する

---

## 6. 型設計（差分のみ）

`src/types/skillTest.ts`（新規・**作成済み**。v1 で使わない項目は残置）

```ts
SkillBonusTable        // { normal, rare, evolved }        ← 使用
SkillTestCourseDef     // { id, name, aptitudeAxis, bonusSkills, thresholds } ← 使用
SkillTestEditionDef    // { id, name, scenarioId?, skillBonus, courses }      ← 使用
SkillTestSolveConfig   // { courseMultiplier, skillBonus, bonusSkillIds }     ← 使用
SkillTestScoreBreakdown// { gradeValue, skillBonus, statBonus, raceBonus, scenarioBonus, total } ← 使用（後半3つは常に0）
StatBonusRule/StatValues/StatKey  // v1 未使用（将来のステータス入力用に残置）
```

`src/types/solver.ts`（**変更済み**・追加のみで後方互換）

```ts
SolverOptions.mode?: 'grade' | 'skillTest'
SolverOptions.skillTest?: SkillTestSolveConfig
RecommendedSkill.bonusPoints?: number
RecommendedSkill.scoreGain?: number
SolverResult.scoreBreakdown?: SkillTestScoreBreakdown
SolverResult.skillBonusTotal?: number
EvolutionRecommendation.scoreDelta?: number
```

> v1 実装時に `SkillTestEditionDef.statBonuses` は**任意項目に変更**する（データに無いため）。

---

## 7. ファイル別 変更一覧

| ファイル | 種別 | 内容 | 規模 |
|---|---|---|---|
| `src/types/skillTest.ts` | 既存(新規作成済) | `statBonuses` を任意化 | 小 |
| `src/types/solver.ts` | 既存(変更済) | 追加フィールドのみ | 変更不要 |
| `public/data/skill_test_courses.json` | 新規 | 上記JSON（フリーのみ） | 小 |
| `src/data/skillTestStore.ts` | 新規(要書換) | 上記APIに整理 | 小 |
| `src/solver/skillSolver.ts` | 変更 | 4章の内容 | **中** |
| `src/components/ConditionPanel.tsx` | 変更 | モードトグル追加のみ | 小 |
| `src/components/OptimizationPanel.tsx` | 変更 | 技能試験時の表示分岐 | 中 |
| `src/App.tsx` | 変更 | mode state・データロード・options 受け渡し | 小 |
| `scripts/test-standalone.mjs` | 変更 | 9章のテスト追加 | 中 |

実装順序（この順で1ファイルずつ）:
1. 型の微修正 → 2. JSON → 3. Store → 4. Solver（+typecheck） → 5. App → 6. ConditionPanel → 7. OptimizationPanel → 8. テスト

---

## 8. UI 仕様

### 8.1 ConditionPanel（左サイドバー）

- 追加するのは**トグル1つだけ**（ステータス入力・課程セレクタは作らない）

```
┌─────────────────────────────┐
│ 最適化モード                 │
│ [ 評価点 ] [ 技能試験 ]      │  ← 選択中は緑
│ ※技能試験 = フリー課程       │  ← 補足1行（グレー小字）
└─────────────────────────────┘
```

- 既存の `uma-btn` / `uma-window` 系クラスを流用
- 課程は「フリー課程」固定なのでセレクタは置かず、補足テキストで明示

### 8.2 OptimizationPanel（右メイン）

`mode === 'skillTest'` のときのみ以下に差し替え。`'grade'` は**現状のまま**。

| 要素 | grade モード（既存） | skillTest モード |
|---|---|---|
| 見出し | 最適化シミュレーション | 最適化シミュレーション |
| 主数値ラベル | 到達想定スキル評価点 | **到達想定スコア** |
| 主数値 | `maxGradeValue` | `scoreBreakdown.total` |
| サブ | `(+totalAdditionalGrade pt)` | `(+増分 pt)` ※スコア増分 |
| 内訳行 | なし | **`評価点 {gradeValue} ／ スキル +{skillBonus}`**（小字1行） |
| 推奨行の効果 | `+{effectiveGrade} pt` | `+{scoreGain} pt` ＋ 小字 `評価点 +{effectiveGrade} / ボーナス +{bonusPoints}` |
| 効率 | `pt/SP` | `score/SP`（同じ枠） |
| 進化行 | `+{gradeValue} pt` | `+{scoreDelta} pt` |
| 優ラインバッジ | なし | **なし**（v1） |

- 「※スキル分のみ（基礎能力・レース・シナリオは含まない）」の注記を1行入れる（数値の誤解を防ぐため）

### 8.3 App.tsx

- state 追加: `solverMode: 'grade' | 'skillTest'`（既定 `'grade'`）
- 初期ロードで `SkillTestStore.load()` を実行（`MasterStore` と同様）。失敗時は `console.error` のみで評価点モードのまま動作継続
- ソルバ呼び出し options に `mode` と、skillTest 時のみ `skillTest: store.getSolveConfig(editionId, 'free')` を付与
- **依存配列に `solverMode` を追加**（切替で再計算させる）
- 既存の 60ms デバウンスは維持

---

## 9. テスト仕様（`scripts/test-standalone.mjs` に追加）

| # | ケース | 期待 |
|---|---|---|
| T1 | フリー課程のスコア計算（実データ） | テンポアップ(217/SP160/適性無条件) = `239 + 400 = 639`、効率 `3.99` |
| T2 | 70緑相当（基礎129） | `129 + 400 = 529` |
| T3 | 継承進化（rarity6） | 実データの継承進化は適性条件なし → `240 + 1500 = 1740`。適性1.1倍がかかる rarity6 なら `264 + 1500 = 1764`（ §13 申し送り参照） |
| T4 | ○→◎（同一系統・どちらも白） | Δボーナス **0**、Δ評価点のみ |
| T5 | 白→金（同一系統） | Δボーナス **+800** |
| T6 | 金→進化 | Δボーナス **+300** |
| T7 | 固有(3..5)・デバフ | ボーナス **0**（加点されない） |
| T8 | `'grade'` モード回帰 | 同一入力で `maxGradeValue` が**改修前と一致** |
| T9 | 整合性 | `scoreBreakdown.total === gradeValue + skillBonus` |
| T10 | 最適解の差 | 技能試験モードの推奨に「評価点は低いが安い白スキル」が入り得る |
| T11 | 取得済みの紫（マイナス効果）スキル | ボーナス **0**（+400 が付かない） |

---

## 10. 受け入れ条件（完了定義）

1. `pnpm typecheck` が **PASS**
2. `pnpm test` が **48件すべて PASS**（既存36件は無修正でpass、追加12件）
3. 評価点モードの画面・数値が**改修前と同一**
4. 技能試験モードで、スコア・内訳・推奨リスト・効率が上記仕様通りに表示される
5. `pnpm build` が成功する
6. 既知の制約を UI に明記（スキル分のみ／フリー課程のみ）

> lint / build は当初 `ERR_MODULE_NOT_FOUND`（`@humanfs/node` / `rolldown`）で実行不能だったが、原因は pnpm の依存リンク欠落であり、`pnpm install --force` で解消した（コード起因ではない）。修復後は両方 PASS。詳細は §13。

---

## 11. リスク・注意点

| リスク | 対応 |
|---|---|
| 数値は公開情報ベースで**実機検証していない** | データJSON化により、誤りが見つかればデータ修正のみで直せる |
| 系統（`groupId`）に「金と白を同時に持てる」ケースがある可能性 | 既存ツールの系統モデル（1系統1選択）を踏襲。挙動変更は別課題とする |
| ステータス／レース／シナリオを除外したため、総スコアは実機より小さい | UIに「スキル分のみ」と明記 |
| イベント回ごとにボーナス値・課程構成が変わる | JSON差し替えで対応（版を `id` で管理） |
| フリー課程の実スコア上限が不明 | v1では絶対値の妥当性検証はせず、相対比較（推奨の妥当性）を主目的とする |

---

## 12. 参考（計算例：このモードで結論が変わる例）

適性: 中距離A・先行A（= 距離系スキルは 1.1倍）

| スキル | 基礎 | 評価点 | +ボーナス | スコア | SP | スコア効率 |
|---|---|---|---|---|---|---|
| 中距離直線○ | 217 | 239 | +400 | 639 | 100 | 6.39 |
| 中距離直線◎ | 262 | 288 | +400 | 688 | 110 | **6.25** |
| テンポアップ | 217 | 239 | +400 | 639 | 160 | 3.99 |
| 読解力 | 85 | 94 | +400 | 494 | 120 | **4.12** |
| 意気衝天（金） | 508 | 559 | +1,200 | 1,759 | 160 | 10.99 |

- ○→◎ は **SP110 使ってスコア +49**（0.45/SP）しか増えない → 最適解でほぼ選ばれない
- 評価点では負けていた **読解力(4.12) が テンポアップ(3.99) を逆転**する

---

## 13. 実装結果・申し送り（実装後追記）

実装完了: 2026-11-20。v1（フリー課程のみ）を実装し、以下を検証した。

| 検証 | 結果 |
|---|---|
| `pnpm typecheck` | **PASS** |
| `pnpm test` | **48件 / 48 pass**（既存36件は無修正、追加12件） |
| `pnpm build` | **成功** |
| `pnpm lint` | **PASS**（`--max-warnings 0`） |

### 13.1 環境メモ（重要）

初回の `pnpm install` が依存パッケージのリンクを欠落させた状態で終わっており、`eslint`（`@humanfs/node`）と `vite build`（`rolldown`）が `ERR_MODULE_NOT_FOUND` で起動不能だった。
**`pnpm install --force` を実行すると解消**する（`.pnpm` には存在するが `node_modules/.pnpm/<pkg>/node_modules/` にリンクされていない状態だった）。コード起因ではない。
さらに、`pnpm test` は PATH 上の Node が 22.12 だと TS の type stripping が効かず失敗する。**Node 22.13 以上（検証は v24.21.0）で実行すること**。

### 13.2 実装中に修正した2点

1. **枝刈りをスコア基準に変更** — 既存の枝刈りは `Δ評価点 > 0` で判定していたため、技能試験では「評価点は下がるがボーナス増で得」な進化（例: 継承進化 +1,100）を取り逃がす。各オプションの `scoreValue` で比較するよう変更した。`grade` モードでは `scoreValue === 評価点` なので**従来と完全に同値**（既存36テストが無修正で pass することで担保）。
2. **取得済みの紫（マイナス効果）スキルに +400 が付くバグを修正** — 既取得スキルのボーナス集計と系統の基準ボーナスが `groupRate <= 0 / gradeValue <= 0` を除外していなかった。修正し、回帰テスト T11 を追加。

### 13.3 申し送り（未解決・要判断）

1. ~~`1764` と `1740` の差異~~ → **§14 のオーバーレイで解消済み（1,764 を再現）**。原因は「`skill_master.json` が説明文由来の適性条件を `distanceTypes`/`runningStyles` に構造化していない」ことだった。
2. **`courseMultiplier ≠ 1.0` にすると `total !== maxGradeValue + skillBonusTotal` になる**。`gradeValue` 側にのみ倍率が乗るため（v1 はフリー = 1.0 なので未顕在）。距離課程を実装する際に表示ロジックの再検討が必要。
3. **`scoreValue` は `Math.round` している**（DP の配列が `Int32Array` のため）。倍率 1.0 では整数のままなので影響なし。0.9 等の倍率を使う場合は 10 倍スケーリング等の再検討が必要。
4. **系統（`groupId`）= 1系統1選択**という既存ツールのモデルを踏襲している。実機で「金と白を同時に保有できる」場合は評価点・ボーナスの双方で過小評価になるが、既存の評価点計算からの課題であり本モード固有ではない。

### 13.4 追加・変更ファイル

| ファイル | 種別 |
|---|---|
| `src/types/skillTest.ts` | 新規（技能試験の型） |
| `src/types/solver.ts` | 変更（任意フィールド追加のみ） |
| `public/data/skill_test_courses.json` | 新規（版・課程・ボーナス値） |
| `src/data/skillTestStore.ts` | 新規（課程データのローダ） |
| `src/solver/skillSolver.ts` | 変更（技能試験モード・スコア集計・枝刈り） |
| `src/components/ConditionPanel.tsx` | 変更（モードトグル追加） |
| `src/components/OptimizationPanel.tsx` | 変更（スコア表示分岐） |
| `src/App.tsx` | 変更（モード state・データロード・オプション受け渡し） |
| `scripts/test-standalone.mjs` | 変更（T1〜T11 追加） |
| `public/data/skill_aptitude_overrides.json` | 新規（説明文由来の適性条件の補完） |
| `src/data/masterStore.ts` | 変更（オーバーレイ適用 `applyAptitudeOverrides`） |
| `src/types/master.ts` | 変更（`SkillAptitudeOverride` 型追加） |
| `docs/skill-aptitude-review.csv` | 新規（レビュー用一覧・適用結果つき） |
| `docs/skill-test-spec.md` / `docs/skill-test-design.md` | 新規（仕様書・設計書） |

---

## 14. 適性条件オーバーレイ（説明文由来の条件補完）

### 14.1 背景

`skill_master.json` には、**説明文にしか適性条件が無いスキル**が存在する（`distanceTypes`/`runningStyles` が空）。実データで **74件**、うち購入・進化対象（rarity 1/6）は **38件**。このままだと適性倍率が 1.0 で計算され、評価点・スコアが ±18〜72 点ずれる（継承進化なら 1,740 対 1,764）。

### 14.2 方針

**説明文からの自動変換はしない。** 「説明文に書いてあっても実際には条件が適用されない」ケースがあるため（例: `我が意、即ち天の理なり` の「2000m以上」には ＜中距離・長距離＞ 条件が付かない）、**明示的に列挙したものだけを JSON で補完**する。

### 14.3 変換ルール（確定）

| 記法 | 解釈 | 実装 |
|---|---|---|
| `＜A/B＞`（または型） | 同軸の複数値 | 同じ軸の配列に複数値（評価点計算が max を取る＝または） |
| `＜A・B＞`（かつ型） | 距離と脚質の両方 | **別々の軸**に入れる（距離×脚質で乗算される＝かつ） |
| `＜作戦・先行＞` | 対象脚質が1種だけの表記 | **「作戦」を無視**し脚質のみ（`[2]`） |
| `＜差し・芝＞` | 芝は倍率対象外 | **芝/ダートを無視**し脚質のみ（`[3]`） |
| `＜＞` が無い | 文面から明確なものだけ手動 | `ずっとずっと輝いて` → ＜マイル/中距離＞＝**または** → `[2,3]` |

「同じ軸なら配列（max＝または）／違う軸なら乗算（かつ）」という**既存の評価点実装にそのまま対応する**ため、記号（`/` と `・`）を個別に判定する必要がない。

### 14.4 適用範囲

- **適用済み: 39件**（継承固有 rarity1 が36件、継承進化 rarity6 が3件）
  - 一覧: `docs/skill-aptitude-review.csv`（`適用` 列 ○、補完後の配列を併記）
- **未適用: rarity5 の固有36件** — 購入できず最適化の変数にならないため。ただし「現在の評価点」の表示には影響しうる（固有スキルの評価点モデル自体が既存ツールの課題）
- マスタ側に値がある軸は**上書きしない**（例: `distanceTypes` 有り／`runningStyles` 空 なら、空の軸だけ補完）

### 14.5 実装

- `public/data/skill_aptitude_overrides.json` … `{ "<skillId>": { "distanceTypes"?: number[], "runningStyles"?: number[] } }`。先頭 `_` のキーは注記として無視
- `MasterStore.load(url, overridesUrl)` … マスタ読込後に自動取得（**失敗時は警告のみで継続**、評価点モードは動作継続）
- `MasterStore.applyAptitudeOverrides(overrides)` … 冪等。`init()` より先に呼ばれても保持し、`init` 時に適用
- 未知のIDは `console.warn`（データ更新でスキルが消えた場合の検知用）

### 14.6 テスト

- **T3 更新**: 継承進化 901351→91101351 が補完後 `180→198` / `240→264` となり、`Δ評価点 66 + Δボーナス 1,100 = scoreDelta 1,166`・スコア **1,764**
- **T12 追加**: 作戦の無視・芝の無視・または型（ずっとずっと輝いて = 1,764）・マスタ優先（空の軸だけ補完）を検証
- 結果: **49件 / 49 pass**
