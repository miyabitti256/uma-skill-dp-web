import { UmaModal } from './UmaModal.tsx';

interface UsageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UsageModal({ isOpen, onClose }: UsageModalProps) {
  return (
    <UmaModal isOpen={isOpen} onClose={onClose} title="使い方" titleId="usage-modal-title">
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
            育成ウマ娘・シナリオを選択すると、下部に推奨進化スキル選択が表示されます。
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
    </UmaModal>
  );
}
