import { useState, useMemo } from 'react';
import { SolverResult, RecommendedSkill, EvolutionRecommendation } from '../types/solver.ts';
import { Plus, Lock, Ban, ChevronRight, AlertCircle } from 'lucide-react';
import { AnimatedNumber } from './AnimatedNumber.tsx';

interface OptimizationPanelProps {
  solverResult: SolverResult | null;
  availableSp: number;
  onApplySkill: (skillId: number) => void;
  onToggleLock: (skillId: number) => void;
  onToggleExclude: (skillId: number) => void;
}

interface RecommendedSkillRowProps {
  item: RecommendedSkill;
  onApplySkill: (skillId: number) => void;
  onToggleLock: (skillId: number) => void;
  onToggleExclude: (skillId: number) => void;
}

function RecommendedSkillRow({
  item,
  onApplySkill,
  onToggleLock,
  onToggleExclude,
}: RecommendedSkillRowProps) {
  const { skill, effectiveCost, effectiveGrade, costPerformance } = item;
  const isGold = skill.rarity === 2;
  const isUnique = skill.rarity >= 3;

  const cardClass = isUnique
    ? 'uma-skill-rainbow'
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
      className={`uma-animate-card uma-skill-card px-2 py-1.5 flex items-center justify-between gap-2 ${cardClass}`}
    >
      {/* 左: ゲーム風スキルアイコン枠 + テキスト */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div
          className={`w-7 h-7 rounded-md flex items-center justify-center font-black text-[11px] shrink-0 ${iconClass}`}
        >
          {isUnique ? '固' : isGold ? '金' : '白'}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-extrabold text-[#5b4333] truncate">{skill.name}</span>
            {item.reason && (
              <span className="text-[10px] text-[#0369a1] bg-white/90 px-1.5 py-0.5 rounded border border-[#7dd3fc] font-bold shrink-0 leading-none">
                {item.reason}
              </span>
            )}
          </div>

          <div className="border-t border-[#5b4333]/15 mt-0.5 pt-0.5 flex items-center gap-2.5 text-[11px] text-[#7a6352] font-mono">
            <span>
              効果 <strong className="text-[#3c8604] font-black">+{effectiveGrade}</strong> pt
            </span>
            <span className="text-[#9e9aa6]">|</span>
            <span>
              効率 <strong className="text-[#0369a1] font-bold">{costPerformance}</strong> pt/SP
            </span>
          </div>
        </div>
      </div>

      {/* 右: 実機準拠 [SP数値] + [+]緑ボタン + ロック/除外 */}
      <div className="flex items-center gap-1 shrink-0">
        <span
          className="uma-sp-box px-2 py-0.5 min-w-[42px] text-center font-mono text-xs font-black text-[#5b4333] tabular-nums"
          title={`必要SP: ${effectiveCost}`}
        >
          {effectiveCost}
        </span>

        <button
          onClick={() => onApplySkill(skill.id)}
          className="uma-btn-green w-7 h-7 flex items-center justify-center shrink-0"
          title="このスキルを獲得済にする"
        >
          <Plus className="w-4 h-4 stroke-[3]" />
        </button>

        <button
          onClick={() => onToggleLock(skill.id)}
          className={`p-1 rounded border transition ${
            skill.isLocked
              ? 'bg-[#e0f2fe] text-[#0369a1] border-[#38bdf8]'
              : 'bg-white/80 text-[#866d59] border-[#c6c3cc] hover:text-[#5b4333]'
          }`}
          title={skill.isLocked ? 'ロック解除' : '必須取得にロック'}
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
          title="このスキルを除外"
        >
          <Ban className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function EvolutionRow({ evo }: { evo: EvolutionRecommendation }) {
  return (
    <div
      className={`px-2 py-1.5 rounded-md border text-xs flex items-center justify-between gap-2 ${
        evo.canEvolve
          ? 'bg-[#fff3f8] border-[#f472b6]'
          : 'bg-white border-[#d6d3dc] text-[#7f6958]'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-5 h-5 rounded flex items-center justify-center font-black text-[10px] shrink-0 border ${
            evo.canEvolve
              ? 'bg-[#e4418d] text-white border-[#b52468]'
              : 'bg-[#e9e7ef] text-[#7f6958] border-[#c6c3cc]'
          }`}
        >
          進
        </span>

        <div className="min-w-0">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="font-bold text-[#5b4333] truncate">{evo.slotName}</span>
            <ChevronRight className="w-3 h-3 text-[#9e9aa6] shrink-0" />
            <span className="font-bold text-[#7a4b63] truncate">
              {evo.evolvedSkill ? evo.evolvedSkill.name : evo.baseSkillName}
            </span>
          </div>
        </div>
      </div>

      {evo.canEvolve && evo.evolvedSkill ? (
        <span className="font-mono text-[11px] font-black text-[#be185d] bg-white px-1.5 py-0.5 rounded border border-[#f9a8d4] shrink-0">
          +{evo.evolvedSkill.gradeValue} pt
        </span>
      ) : (
        <AlertCircle className="w-3.5 h-3.5 text-[#9e9aa6] shrink-0" />
      )}
    </div>
  );
}

export function OptimizationPanel({
  solverResult,
  availableSp,
  onApplySkill,
  onToggleLock,
  onToggleExclude,
}: OptimizationPanelProps) {
  const [sortBy, setSortBy] = useState<'order' | 'costPerformance'>('order');

  const sortedRecommendedSkills = useMemo(() => {
    if (!solverResult) return [];
    const list = [...solverResult.recommendedSkills];
    if (sortBy === 'order') {
      return list.sort((a, b) => (a.skill.firstSeenOrder ?? 999999) - (b.skill.firstSeenOrder ?? 999999));
    }
    return list.sort((a, b) => b.costPerformance - a.costPerformance);
  }, [solverResult, sortBy]);

  if (!solverResult) {
    return (
      <div className="uma-window p-6 flex items-center justify-center text-[#7f6958] h-full min-h-[260px]">
        <p className="text-xs font-bold">スキルまたはウィンドウを検出すると推奨が表示されます</p>
      </div>
    );
  }

  const {
    maxGradeValue,
    totalAdditionalGrade,
    spentSp,
    remainingSp,
    recommendedSkills,
    evolutionRecommendations,
  } = solverResult;

  const gaugePercent = Math.min(100, availableSp > 0 ? (spentSp / availableSp) * 100 : 0);

  return (
    <div className="flex flex-col gap-2.5 h-full min-h-0">
      {/* 1. 評価点・SP集計サマリー */}
      <section className="uma-window overflow-hidden shrink-0">
        <div className="uma-bar px-3 py-1 flex items-center justify-between">
          <span className="font-extrabold text-xs">最適化シミュレーション</span>
        </div>

        <div className="p-2.5 bg-white">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div>
              <span className="text-[11px] font-bold text-[#7f6958] block">
                到達想定スキル評価点
              </span>
              <div className="flex items-baseline gap-2">
                <AnimatedNumber
                  value={maxGradeValue}
                  className="text-2xl font-black text-[#5b4333] font-mono tracking-tight tabular-nums"
                />
                <span className="text-xs font-black text-[#3c8604] font-mono tabular-nums">
                  (+<AnimatedNumber value={totalAdditionalGrade} /> pt)
                </span>
              </div>
            </div>

            <div className="text-right font-mono tabular-nums">
              <span className="text-[10px] font-bold text-[#7f6958] block">SP消費状況</span>
              <div className="text-sm font-black text-[#5b4333]">
                <span className="text-[#d96200]">{spentSp}</span>
                <span className="text-[#9e9aa6] mx-0.5">/</span>
                <span>{availableSp}</span>
              </div>
              <span className="text-[10px] font-bold text-[#3c8604] block">
                余り {remainingSp} Pt
              </span>
            </div>
          </div>

          <div className="w-full bg-[#e9e7ef] h-2 rounded-full overflow-hidden border border-[#c6c3cc]">
            <div
              className="uma-gauge-fill h-full transition-all duration-300"
              style={{ width: `${gaugePercent}%` }}
            />
          </div>
        </div>
      </section>

      {/* 2. 取得推奨スキル一覧 */}
      <section className="uma-window overflow-hidden flex-1 flex flex-col min-h-0">
        <div className="uma-bar px-3 py-1 flex items-center justify-between gap-2">
          <h3 className="text-xs font-extrabold truncate">
            取得推奨スキル ({recommendedSkills.length}件)
          </h3>

          <div className="flex items-center gap-1 bg-white/90 p-0.5 rounded text-[10px] shrink-0 z-10">
            <button
              onClick={() => setSortBy('order')}
              className={`px-2 py-0.5 rounded font-bold transition ${
                sortBy === 'order'
                  ? 'bg-[#56b308] text-white'
                  : 'text-[#6b5342] hover:text-[#5b4333]'
              }`}
            >
              認識順
            </button>
            <button
              onClick={() => setSortBy('costPerformance')}
              className={`px-2 py-0.5 rounded font-bold transition ${
                sortBy === 'costPerformance'
                  ? 'bg-[#56b308] text-white'
                  : 'text-[#6b5342] hover:text-[#5b4333]'
              }`}
            >
              コスパ順
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-2 space-y-1.5 min-h-[160px] bg-[#f4f3f1]">
          {sortedRecommendedSkills.length === 0 ? (
            <div className="flex items-center justify-center h-28 text-xs font-bold text-[#7f6958] bg-white rounded border border-[#d6d3dc]">
              取得可能な推奨スキルはありません
            </div>
          ) : (
            sortedRecommendedSkills.map((item) => (
              <RecommendedSkillRow
                key={item.skill.id}
                item={item}
                onApplySkill={onApplySkill}
                onToggleLock={onToggleLock}
                onToggleExclude={onToggleExclude}
              />
            ))
          )}
        </div>
      </section>

      {/* 3. 推奨進化スキル選択 */}
      <section className="uma-window overflow-hidden shrink-0">
        <h3 className="uma-bar-pink px-3 py-1 text-xs font-extrabold">
          推奨進化スキル選択
        </h3>

        <div className="p-2 space-y-1.5 bg-[#f4f3f1]">
          {evolutionRecommendations.length === 0 ? (
            <div className="text-xs font-bold text-[#7f6958] bg-white rounded border border-[#d6d3dc] px-2.5 py-2">
              育成ウマ娘またはシナリオを選択すると進化推奨が表示されます
            </div>
          ) : (
            evolutionRecommendations.map((evo, idx) => (
              <EvolutionRow key={`${evo.slotType}-${evo.baseSkillId}-${idx}`} evo={evo} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
