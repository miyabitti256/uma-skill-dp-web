import { useState, useMemo, useDeferredValue, useRef, useEffect } from 'react';
import { DetectedSkillItem, SkillState } from '../types/recognition.ts';
import { Trash2, Search, Lock, Ban, ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';

interface RecognizedSkillsPanelProps {
  skills: DetectedSkillItem[];
  onSkillStateChange: (skillId: number, state: SkillState) => void;
  onSkillCostChange: (skillId: number, newCost: number) => void;
  onToggleLock: (skillId: number) => void;
  onToggleExclude: (skillId: number) => void;
  onClearSkills: () => void;
}

interface RecognizedSkillRowProps {
  skill: DetectedSkillItem;
  onSkillStateChange: (skillId: number, state: SkillState) => void;
  onSkillCostChange: (skillId: number, newCost: number) => void;
  onToggleLock: (skillId: number) => void;
  onToggleExclude: (skillId: number) => void;
}

function RecognizedSkillRow({
  skill,
  onSkillStateChange,
  onSkillCostChange,
  onToggleLock,
  onToggleExclude,
}: RecognizedSkillRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [tempCost, setTempCost] = useState('');

  const isGold = skill.rarity === 2;
  const isUnique = skill.rarity >= 3;

  const startEditCost = () => {
    setTempCost(skill.recognizedCost.toString());
    setIsEditing(true);
  };

  const saveCost = () => {
    const cost = parseInt(tempCost, 10);
    if (!isNaN(cost) && cost >= 0) {
      onSkillCostChange(skill.id, cost);
    }
    setIsEditing(false);
  };

  const cardClass = skill.isExcluded
    ? 'opacity-45 bg-[#ecebef] border-[#c6c3cc]'
    : isUnique
    ? 'uma-skill-rainbow'
    : skill.state === 'acquired'
    ? 'uma-skill-acquired'
    : isGold
    ? 'uma-skill-gold'
    : 'uma-skill-white';

  const iconClass = isUnique
    ? 'uma-icon-frame-rainbow'
    : isGold
    ? 'uma-icon-frame-gold'
    : 'uma-icon-frame-white';

  return (
    <div
      data-testid="recognized-skill-row"
      className={`uma-animate-card uma-skill-card px-2 py-1.5 flex items-center justify-between gap-2 text-xs ${cardClass}`}
    >
      {/* 左: アイコン枠 + スキル情報 */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div
          className={`w-7 h-7 rounded-md flex items-center justify-center font-black text-[11px] shrink-0 ${iconClass}`}
        >
          {isUnique ? '固' : isGold ? '金' : '白'}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              data-testid="recognized-skill-name"
              className="font-extrabold text-[#5b4333] truncate"
            >
              {skill.name}
            </span>

            {skill.canEvolve && (
              <span className="text-[10px] bg-[#e4418d] text-white px-1.5 py-0.5 rounded border border-[#b52468] font-black shrink-0 leading-none">
                進化
              </span>
            )}
          </div>

          <div className="border-t border-[#5b4333]/15 mt-0.5 pt-0.5 flex items-center gap-2 text-[11px] text-[#7a6352] font-mono">
            <span>
              評価: <strong className="text-[#3c8604] font-black">{skill.gradeValue}</strong> pt
            </span>
            <span className="text-[#9e9aa6]">|</span>

            <div className="flex items-center gap-1">
              <span>SP:</span>
              {isEditing ? (
                <input
                  type="number"
                  value={tempCost}
                  onChange={(e) => setTempCost(e.target.value)}
                  onBlur={saveCost}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveCost();
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                  autoFocus
                  className="w-12 bg-white border border-[#d96200] rounded px-1 py-0 text-[#d96200] font-black focus:outline-none"
                />
              ) : (
                <button
                  onClick={startEditCost}
                  className="uma-sp-box px-1.5 py-0 text-[#d96200] hover:underline font-black leading-tight"
                  title="クリックで認識SPを手動微調整"
                >
                  {skill.recognizedCost}
                </button>
              )}
              {skill.recognizedCost !== skill.baseCost && (
                <span className="text-[10px] text-[#7f6958]">(定価 {skill.baseCost})</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 右: 状態切替スイッチ & ロック/除外 */}
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex rounded border border-[#b4b0bc] bg-[#efedf3] p-0.5 text-[10px] font-bold">
          <button
            onClick={() => onSkillStateChange(skill.id, 'unselected')}
            aria-pressed={skill.state === 'unselected'}
            className={`px-1.5 py-0.5 rounded-sm transition ${
              skill.state === 'unselected'
                ? 'bg-[#6b5342] text-white'
                : 'text-[#7f6958] hover:text-[#5b4333]'
            }`}
          >
            未選択
          </button>
          <button
            onClick={() => onSkillStateChange(skill.id, 'selected')}
            aria-pressed={skill.state === 'selected'}
            className={`px-1.5 py-0.5 rounded-sm transition ${
              skill.state === 'selected'
                ? 'bg-[#e4418d] text-white'
                : 'text-[#7f6958] hover:text-[#5b4333]'
            }`}
          >
            選択中
          </button>
          <button
            onClick={() => onSkillStateChange(skill.id, 'acquired')}
            aria-pressed={skill.state === 'acquired'}
            className={`px-1.5 py-0.5 rounded-sm transition ${
              skill.state === 'acquired'
                ? 'bg-[#56b308] text-white'
                : 'text-[#7f6958] hover:text-[#5b4333]'
            }`}
          >
            獲得済
          </button>
        </div>

        <button
          onClick={() => onToggleLock(skill.id)}
          className={`p-1 rounded border transition ${
            skill.isLocked
              ? 'bg-[#e0f2fe] text-[#0369a1] border-[#38bdf8]'
              : 'bg-white/80 text-[#866d59] border-[#c6c3cc] hover:text-[#5b4333]'
          }`}
          title={skill.isLocked ? '必須取得ロック中' : '必須取得にロック'}
        >
          <Lock className="w-3 h-3" />
        </button>

        <button
          onClick={() => onToggleExclude(skill.id)}
          className={`p-1 rounded border transition ${
            skill.isExcluded
              ? 'bg-[#ffe4e6] text-[#be123c] border-[#fb7185]'
              : 'bg-white/80 text-[#866d59] border-[#c6c3cc] hover:text-[#5b4333]'
          }`}
          title={skill.isExcluded ? '除外中' : '除外する'}
        >
          <Ban className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

export function RecognizedSkillsPanel({
  skills,
  onSkillStateChange,
  onSkillCostChange,
  onToggleLock,
  onToggleExclude,
  onClearSkills,
}: RecognizedSkillsPanelProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [stateFilter, setStateFilter] = useState<'all' | SkillState>('all');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevSkillCountRef = useRef(0);

  const filteredSkills = useMemo(() => {
    const q = deferredSearchTerm.trim().toLowerCase();
    const list =
      stateFilter === 'all' && !q
        ? [...skills]
        : skills.filter((s) => {
            if (stateFilter !== 'all' && s.state !== stateFilter) return false;
            if (q && !s.name.toLowerCase().includes(q)) return false;
            return true;
          });

    list.sort((a, b) => {
      const orderA = a.firstSeenOrder ?? a.id;
      const orderB = b.firstSeenOrder ?? b.id;
      return sortOrder === 'desc' ? orderB - orderA : orderA - orderB;
    });
    return list;
  }, [skills, stateFilter, deferredSearchTerm, sortOrder]);

  useEffect(() => {
    const prevCount = prevSkillCountRef.current;
    prevSkillCountRef.current = skills.length;
    if (skills.length > prevCount && listRef.current) {
      if (sortOrder === 'asc') {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      } else {
        listRef.current.scrollTop = 0;
      }
    }
  }, [skills.length, sortOrder]);

  return (
    <section
      data-testid="recognized-skills-panel"
      className="uma-window overflow-hidden flex flex-col h-full min-h-0"
    >
      {/* ヘッダーバー */}
      <div className="uma-bar px-3 py-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-xs font-extrabold truncate">
            認識済みスキル ({skills.length}件)
          </h3>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 z-10">
          <div
            className="flex items-center gap-0.5 bg-white/90 p-0.5 rounded text-[10px]"
            role="group"
            aria-label="認識済みスキルの並び順"
          >
            <button
              type="button"
              onClick={() => setSortOrder('desc')}
              aria-pressed={sortOrder === 'desc'}
              data-testid="sort-desc-btn"
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold transition ${
                sortOrder === 'desc'
                  ? 'bg-[#56b308] text-white'
                  : 'text-[#6b5342] hover:text-[#5b4333]'
              }`}
              title="新しく認識したスキルを上に追加（降順）"
            >
              <ArrowDownWideNarrow className="w-3 h-3" />
              降順
            </button>
            <button
              type="button"
              onClick={() => setSortOrder('asc')}
              aria-pressed={sortOrder === 'asc'}
              data-testid="sort-asc-btn"
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold transition ${
                sortOrder === 'asc'
                  ? 'bg-[#56b308] text-white'
                  : 'text-[#6b5342] hover:text-[#5b4333]'
              }`}
              title="認識順で並べて自動スクロール（昇順）"
            >
              <ArrowUpNarrowWide className="w-3 h-3" />
              昇順
            </button>
          </div>

          <button
            onClick={onClearSkills}
            className="uma-btn flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 hover:text-[#be123c]"
            title="認識済みスキル一覧をクリア"
          >
            <Trash2 className="w-3 h-3" />
            クリア
          </button>
        </div>
      </div>

      {/* 検索 & フィルターバー */}
      <div className="p-2 bg-white border-b border-[#d6d3dc] flex flex-wrap sm:flex-nowrap items-center gap-1.5">
        <div className="relative flex-1 min-w-[130px]">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1.5 text-[#9c8c7e]" />
          <input
            type="text"
            placeholder="スキル名で絞り込み..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-[#f8f7fa] border border-[#c6c3cc] rounded pl-7 pr-2 py-1 text-xs font-bold text-[#5b4333] placeholder-[#9c8c7e] focus:outline-none focus:border-[#76c30f]"
          />
        </div>

        <div className="flex gap-0.5 shrink-0 text-[10px] bg-[#efedf3] p-0.5 rounded border border-[#c6c3cc]">
          {(['all', 'unselected', 'selected', 'acquired'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setStateFilter(filter)}
              className={`px-2 py-0.5 rounded-sm font-bold transition ${
                stateFilter === filter
                  ? 'bg-[#56b308] text-white'
                  : 'text-[#6b5342] hover:text-[#5b4333]'
              }`}
            >
              {filter === 'all'
                ? '全'
                : filter === 'unselected'
                ? '未選択'
                : filter === 'selected'
                ? '選択中'
                : '獲得済'}
            </button>
          ))}
        </div>
      </div>

      {/* スキル一覧リスト */}
      <div
        ref={listRef}
        data-testid="recognized-skills-list"
        className="overflow-y-auto flex-1 p-2 space-y-1.5 min-h-[220px] bg-[#f4f3f1]"
      >
        {filteredSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-xs font-bold text-[#7f6958] bg-white rounded border border-[#d6d3dc]">
            {skills.length === 0
              ? 'ウィンドウキャプチャまたは動画再生でスキルを認識します'
              : '条件に一致するスキルがありません'}
          </div>
        ) : (
          filteredSkills.map((skill) => (
            <RecognizedSkillRow
              key={skill.id}
              skill={skill}
              onSkillStateChange={onSkillStateChange}
              onSkillCostChange={onSkillCostChange}
              onToggleLock={onToggleLock}
              onToggleExclude={onToggleExclude}
            />
          ))
        )}
      </div>
    </section>
  );
}
