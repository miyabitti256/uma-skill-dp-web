# ウマ娘 スキル評価点最大化シミュレーター

ブラウザ完結型のスキル画面画像認識 + 1D DP スキル最適化 Web アプリケーションです。画面キャプチャや動画・画像フレームの認識から評価点最大化の計算まで、すべてブラウザで完結します。

## 開発・検証コマンド

```bash
pnpm install
pnpm run dev        # 開発サーバー起動
pnpm run lint       # ESLint (--max-warnings 0)
pnpm run typecheck  # TypeScript 型チェック
pnpm run test       # スタンドアロン単体テスト (node --test scripts/test-standalone.mjs)
pnpm run build      # 本番ビルド (dist/ 生成)
```
