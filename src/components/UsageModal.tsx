import { useEffect } from 'react';
import { X } from 'lucide-react';

interface UsageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UsageModal({ isOpen, onClose }: UsageModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-3"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="usage-modal-title"
    >
      <div
        className="uma-window w-full max-w-lg overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="uma-bar px-3 py-1.5 flex items-center justify-between">
          <h2 id="usage-modal-title" className="text-sm font-extrabold">
            使い方
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-white/95 hover:text-white p-0.5 rounded"
            aria-label="モーダルを閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3.5 bg-[#f4f3f1] space-y-2.5 text-xs text-[#5b4333] leading-relaxed">
          <div className="bg-white rounded-lg border border-[#d6d3dc] p-2.5 space-y-1">
            <h3 className="font-extrabold text-[#3c8604]">1. 画面共有・スキル読み取り</h3>
            <ul className="list-disc pl-4 space-y-0.5 font-medium">
              <li>
                左上の <strong>「ウィンドウ共有」</strong> からウマ娘のウィンドウを選択（または
                <strong>「動画/画像読込」</strong>・ドラッグ＆ドロップ）します。
              </li>
              <li>
                ゲーム内の <strong>「ウマ娘詳細」</strong> を映すと、バ場・距離・脚質適性と育成ウマ娘を自動設定します。
              </li>
              <li>
                <strong>スキル獲得画面</strong> をスクロールすると、所持スキルPtとスキル一覧が自動蓄積されます。
              </li>
            </ul>
          </div>

          <div className="bg-white rounded-lg border border-[#d6d3dc] p-2.5 space-y-1">
            <h3 className="font-extrabold text-[#3c8604]">2. 最適スキルの確認</h3>
            <ul className="list-disc pl-4 space-y-0.5 font-medium">
              <li>
                中央の <strong>「取得推奨スキル」</strong> に所持SP内で評価点合計が最大になる組み合わせが表示されます。
              </li>
              <li>
                各カードの <strong>＋ボタン</strong> で獲得済へ切替、鍵ボタンで必須取得ロック、禁止ボタンで候補から除外できます。
              </li>
              <li>
                育成ウマ娘・シナリオを選択すると、下部に進化選択ガイドが表示されます。
              </li>
            </ul>
          </div>

          <div className="bg-white rounded-lg border border-[#d6d3dc] p-2.5 space-y-1">
            <h3 className="font-extrabold text-[#3c8604]">3. 認識一覧の調整</h3>
            <ul className="list-disc pl-4 space-y-0.5 font-medium">
              <li>
                右の <strong>「認識済みスキル」</strong> で SP 数値クリックによる手動修正、状態切替（未選択 / 選択中 / 獲得済）、<strong>降順 / 昇順</strong> 切替が行えます。
              </li>
              <li>
                別の育成へ移る際は右上の <strong>「クリア」</strong> で一覧をリセットできます。
              </li>
            </ul>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={onClose}
              className="uma-btn-green px-5 py-1 text-xs font-extrabold"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
