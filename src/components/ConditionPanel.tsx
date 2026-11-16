import { useState, useMemo } from 'react';
import { AptitudeState, AptitudeRank } from '../types/recognition.ts';
import { PlayableCardItem, ScenarioItem } from '../types/master.ts';

interface ConditionPanelProps {
  availableSp: number;
  onSpChange: (sp: number) => void;
  isSpAutoDetected?: boolean;

  aptitudes: AptitudeState;
  onAptitudeChange: (field: keyof AptitudeState, rank: AptitudeRank) => void;
  isAptitudeLocked?: boolean;

  cards: PlayableCardItem[];
  selectedCardId?: number;
  onCardSelect: (cardId: number) => void;
  isCardAutoDetected?: boolean;

  scenarios: ScenarioItem[];
  selectedScenarioId?: number;
  onScenarioSelect: (scenarioId: number) => void;
}

const APTITUDE_ROWS: {
  rowLabel: string;
  fields: { key: keyof AptitudeState; label: string }[];
}[] = [
  {
    rowLabel: 'バ場適性',
    fields: [
      { key: 'turf', label: '芝' },
      { key: 'dirt', label: 'ダート' },
    ],
  },
  {
    rowLabel: '距離適性',
    fields: [
      { key: 'short', label: '短距離' },
      { key: 'mile', label: 'マイル' },
      { key: 'middle', label: '中距離' },
      { key: 'long', label: '長距離' },
    ],
  },
  {
    rowLabel: '脚質適性',
    fields: [
      { key: 'nige', label: '逃げ' },
      { key: 'senkou', label: '先行' },
      { key: 'sashi', label: '差し' },
      { key: 'oikomi', label: '追込' },
    ],
  },
];

const RANKS: AptitudeRank[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

const RANK_BADGE_STYLES: Record<AptitudeRank, string> = {
  S: 'bg-gradient-to-b from-[#fde047] to-[#eab308] text-white border-[#ca8a04]',
  A: 'bg-gradient-to-b from-[#ff7b47] to-[#ea4815] text-white border-[#c2360b]',
  B: 'bg-gradient-to-b from-[#ff77b5] to-[#e43f8c] text-white border-[#be266c]',
  C: 'bg-gradient-to-b from-[#8ce222] to-[#56b50f] text-white border-[#3f8b08]',
  D: 'bg-gradient-to-b from-[#60c5fa] to-[#2596e8] text-white border-[#1b74b8]',
  E: 'bg-gradient-to-b from-[#c084fc] to-[#9333ea] text-white border-[#7522c4]',
  F: 'bg-gradient-to-b from-[#94a3b8] to-[#64748b] text-white border-[#475569]',
  G: 'bg-gradient-to-b from-[#b8bec8] to-[#8d95a3] text-white border-[#6b7280]',
};

export function ConditionPanel({
  availableSp,
  onSpChange,
  isSpAutoDetected,
  aptitudes,
  onAptitudeChange,
  isAptitudeLocked,
  cards,
  selectedCardId,
  onCardSelect,
  isCardAutoDetected,
  scenarios,
  selectedScenarioId,
  onScenarioSelect,
}: ConditionPanelProps) {
  const [cardSearchQuery, setCardSearchQuery] = useState('');

  const filteredCards = useMemo(() => {
    if (!cardSearchQuery.trim()) return cards;
    const q = cardSearchQuery.toLowerCase();
    return cards.filter(
      (c) =>
        c.charaName.toLowerCase().includes(q) ||
        (c.cardTitle && c.cardTitle.toLowerCase().includes(q))
    );
  }, [cards, cardSearchQuery]);

  const cycleRank = (field: keyof AptitudeState) => {
    const current = aptitudes[field];
    const currentIndex = RANKS.indexOf(current);
    const nextIndex = (currentIndex + 1) % RANKS.length;
    onAptitudeChange(field, RANKS[nextIndex]);
  };

  return (
    <section className="uma-window overflow-hidden text-xs">
      {/* 1. 現在のスキルPt (実機スキル獲得上部パネル準拠) */}
      <div className="uma-bar px-3 py-1 flex items-center justify-between">
        <span className="font-extrabold text-xs">現在のスキルPt</span>
        {isSpAutoDetected && (
          <span className="text-[10px] bg-white/95 text-[#3c8604] px-1.5 py-0.5 rounded font-extrabold leading-none">
            自動認識
          </span>
        )}
      </div>

      <div className="p-2.5 bg-white border-b border-[#d6d3dc]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-1">
            <input
              type="number"
              min={0}
              max={99999}
              value={availableSp}
              onChange={(e) => onSpChange(Number(e.target.value) || 0)}
              className="w-24 uma-sp-box px-2 py-1 text-lg font-black text-[#d96200] focus:outline-none focus:border-[#76c30f] font-mono tabular-nums"
            />
            <span className="text-xs font-bold text-[#7f6958]">Pt</span>
          </div>

          <div className="flex gap-1">
            {[100, 300, 500, 1000].map((delta) => (
              <button
                key={delta}
                onClick={() => onSpChange(availableSp + delta)}
                className="uma-btn text-[10px] font-extrabold px-1.5 py-1 tabular-nums"
              >
                +{delta}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. 育成ウマ娘 & 育成シナリオ (実機 編成情報風) */}
      <div className="uma-bar px-3 py-1 flex items-center justify-between">
        <span className="font-extrabold text-xs">育成ウマ娘・シナリオ</span>
        {isCardAutoDetected && (
          <span className="text-[10px] bg-white/95 text-[#3c8604] px-1.5 py-0.5 rounded font-extrabold leading-none">
            特定済
          </span>
        )}
      </div>

      <div className="p-2.5 bg-white border-b border-[#d6d3dc] space-y-2">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] font-bold text-[#6b5342]">育成ウマ娘</label>
            <input
              type="text"
              placeholder="絞り込み検索..."
              value={cardSearchQuery}
              onChange={(e) => setCardSearchQuery(e.target.value)}
              className="w-36 bg-[#f8f7fa] border border-[#c6c3cc] rounded px-2 py-0.5 text-[11px] text-[#5b4333] placeholder-[#9c8c7e] focus:outline-none focus:border-[#76c30f]"
            />
          </div>
          <select
            value={selectedCardId || ''}
            onChange={(e) => onCardSelect(Number(e.target.value))}
            className="w-full bg-[#f8f7fa] border border-[#c6c3cc] rounded px-2 py-1 text-xs font-bold text-[#5b4333] focus:outline-none focus:border-[#76c30f] truncate"
          >
            <option value="">(未選択)</option>
            {filteredCards.map((c) => (
              <option key={c.cardId} value={c.cardId}>
                {c.charaName} {c.cardTitle ? `(${c.cardTitle})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[11px] font-bold text-[#6b5342] block mb-1">育成シナリオ</label>
          <select
            value={selectedScenarioId || ''}
            onChange={(e) => onScenarioSelect(Number(e.target.value))}
            className="w-full bg-[#f8f7fa] border border-[#c6c3cc] rounded px-2 py-1 text-xs font-bold text-[#5b4333] focus:outline-none focus:border-[#76c30f] truncate"
          >
            <option value="">(未選択)</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 3. 適性条件 (実機「ウマ娘詳細」の3行テーブル形式) */}
      <div className="uma-bar px-3 py-1 flex items-center justify-between">
        <span className="font-extrabold text-xs">適性条件 (クリックで変更)</span>
        {isAptitudeLocked && (
          <span className="text-[10px] bg-white/95 text-[#be185d] px-1.5 py-0.5 rounded font-extrabold leading-none">
            詳細画面ロック済
          </span>
        )}
      </div>

      <div className="p-2 bg-white space-y-1.5">
        {APTITUDE_ROWS.map((row) => (
          <div
            key={row.rowLabel}
            className="flex items-center gap-1.5 border-b border-[#eceaef] pb-1.5 last:border-b-0 last:pb-0"
          >
            <span className="text-[11px] font-bold text-[#7f6958] w-12 shrink-0">
              {row.rowLabel}
            </span>
            <div className="grid grid-cols-4 gap-1 flex-1">
              {row.fields.map(({ key, label }) => {
                const rank = aptitudes[key];
                const badgeClass = RANK_BADGE_STYLES[rank];
                return (
                  <button
                    key={key}
                    onClick={() => cycleRank(key)}
                    className="flex items-center justify-between gap-1 px-1.5 py-0.5 rounded bg-[#f8f7fa] border border-[#d6d3dc] hover:border-[#76c30f] active:scale-95 transition text-[11px]"
                    title={`${label}: 現在 ${rank} (クリックで変更)`}
                  >
                    <span className="text-[#5b4333] font-bold text-[10px] truncate">{label}</span>
                    <span
                      className={`w-4 h-4 rounded-sm flex items-center justify-center text-[10px] font-black border shrink-0 shadow-sm ${badgeClass}`}
                    >
                      {rank}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
