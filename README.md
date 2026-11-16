# ウマ娘 スキル評価オプティマイザー

ブラウザ完結型のスキル画面画像認識 + 1D DP スキル最適化 Web アプリケーションです。画面キャプチャや動画・画像フレームの認識から評価点最大化の計算まで、すべてクライアントサイド（ローカルブラウザ）で完結します。

## 主な特徴

- **クライアント完結パイプライン**: React + Vite + マルチ Web Worker プール（`RecognitionWorkerPool`）+ TypeScript 1D DP ソルバーで構成され、外部サーバーへの画像送信を行いません。
- **フォント非依存・不可逆特徴量設計**: `public/data/templates.json` にはフォントファイルや単一文字グリフ辞書を含めず、スキル名・キャラ名の不可逆特徴量、16×20 二値数字マスク（`norm_16x20`）、アンカー情報および離散コスト集合（`valid_costs`）のみを保持します。`ImageRecognizer` は `templates.json` 単体で初期化できます。
- **適性・進化考慮 DP ソルバー**: 距離・脚質適性補正、固有スキル種別（継承 `180pt` / 本体 `340pt`）、自前覚醒 Lv5・シナリオ進化枠・同一グループ排他制約を考慮して獲得すべきスキル組み合わせを最適化します。

## 開発・検証コマンド

```bash
pnpm install
pnpm run dev        # 開発サーバー起動
pnpm run lint       # ESLint (--max-warnings 0)
pnpm run typecheck  # TypeScript 型チェック
pnpm run test       # スタンドアロン単体テスト (node --test scripts/test-standalone.mjs)
pnpm run build      # 本番ビルド (dist/ 生成)
```

*(Windows PowerShell 5.1 では `pnpm.cmd` を使用してください)*

## デプロイ (Cloudflare)

`cloudflare.config.ts` に従い、`pnpm run build` で生成した `dist/` を Cloudflare Workers / Pages へ静的アセットとしてデプロイできます。
