import type { ISkillSolver } from './solverInterface.ts';
import type {
  SolverOptions,
  SolverResult,
  RecommendedSkill,
  EvolutionRecommendation,
} from '../types/solver.ts';
import type { DetectedSkillItem, AptitudeState, AptitudeRank } from '../types/recognition.ts';
import { MasterStore } from '../data/masterStore.ts';
import type { CharaEvolutionItem, SkillMasterItem } from '../types/master.ts';

/**
 * 適性ランク値から評価点倍率を取得
 * S / A => 1.10
 * B / C => 0.90
 * D / E / F => 0.80
 * G => 0.70
 */
function rankMultiplier(rank: AptitudeRank): number {
  switch (rank) {
    case 'S':
    case 'A':
      return 1.1;
    case 'B':
    case 'C':
      return 0.9;
    case 'D':
    case 'E':
    case 'F':
      return 0.8;
    case 'G':
      return 0.7;
    default:
      return 1.0;
  }
}

/**
 * 適性補正後の実効評価点を計算
 * - バ場適性（芝・ダート）は評価点倍率に影響しない（常に 1.0倍）。
 * - distanceTypes が非空なら該当距離の中の最大倍率（空なら 1.0）。
 * - runningStyles が非空なら該当脚質の中の最大倍率（空なら 1.0）。
 * - 実効評価点 = Math.round(gradeValue * rDist * rStyle)
 */
function calculateEffectiveGradeValue(
  gradeValue: number,
  distanceTypes: number[],
  runningStyles: number[],
  aptitudes: AptitudeState
): number {
  let rDist = 1.0;
  if (distanceTypes.length > 0) {
    let maxDist = 0.0;
    for (const d of distanceTypes) {
      let mult = 1.0;
      switch (d) {
        case 1:
          mult = rankMultiplier(aptitudes.short);
          break;
        case 2:
          mult = rankMultiplier(aptitudes.mile);
          break;
        case 3:
          mult = rankMultiplier(aptitudes.middle);
          break;
        case 4:
          mult = rankMultiplier(aptitudes.long);
          break;
      }
      if (mult > maxDist) maxDist = mult;
    }
    rDist = maxDist;
  }

  let rStyle = 1.0;
  if (runningStyles.length > 0) {
    let maxStyle = 0.0;
    for (const s of runningStyles) {
      let mult = 1.0;
      switch (s) {
        case 1:
          mult = rankMultiplier(aptitudes.nige);
          break;
        case 2:
          mult = rankMultiplier(aptitudes.senkou);
          break;
        case 3:
          mult = rankMultiplier(aptitudes.sashi);
          break;
        case 4:
          mult = rankMultiplier(aptitudes.oikomi);
          break;
      }
      if (mult > maxStyle) maxStyle = mult;
    }
    rStyle = maxStyle;
  }

  return Math.round(gradeValue * rDist * rStyle);
}

export const SKILL_TEST_BONUS = {
  normal: 400,
  rare: 1200,
  evolved: 1500,
} as const;

function isInnateUniqueSkill(master: SkillMasterItem | undefined, skill: DetectedSkillItem): boolean {
  const rarity = master ? master.rarity : skill.rarity;
  const needSp = master ? master.needSkillPoint : skill.baseCost;
  return rarity >= 3 && rarity <= 5 && needSp === 0;
}

function tierBonus(rarity: number): number {
  if (rarity === 1) return SKILL_TEST_BONUS.normal;
  if (rarity === 2) return SKILL_TEST_BONUS.rare;
  if (rarity === 6) return SKILL_TEST_BONUS.evolved;
  return 0;
}

interface EvoOptionDetail {
  slotType: 'chara_lv3' | 'chara_lv5' | 'scenario' | 'succession';
  evolvedSkill: SkillMasterItem;
  evoEff: number;
  baseEff: number;
  evoDelta: number;
}

interface DpOption {
  skill: DetectedSkillItem;
  actualCost: number;
  dpCost: number;
  effectiveGrade: number;
  bonusPoints: number;
  scoreValue: number;
  costPerformance: number;
  isLocked: boolean;
  needC3: 0 | 1;
  needC5: 0 | 1;
  needSc: 0 | 1;
  evoDetail?: EvoOptionDetail;
}

interface DpGroup {
  canSkip: boolean;
  isAcquiredGroup: boolean;
  options: DpOption[];
}

interface DpEvolutionAssignment {
  isAcquired: boolean;
  evoDetail: EvoOptionDetail;
}

export class TypeScriptSkillSolver implements ISkillSolver {
  private masterStore: MasterStore;

  constructor(masterStore?: MasterStore) {
    this.masterStore = masterStore || MasterStore.getInstance();
  }

  public solve(skills: DetectedSkillItem[], options: SolverOptions): SolverResult {
    const { availableSp, aptitudes, selectedCardId, selectedScenarioId } = options;
    const isSkillTest = options.mode === 'skillTest';
    const excludedSet = new Set(options.excludedSkillIds ?? []);
    const lockedSet = new Set(options.lockedSkillIds ?? []);

    // 1. スキルの分類（獲得済み・選択中・候補）
    // 同一 groupId に複数の acquired/selected がある場合は最大 groupRate（同率なら最大評価点）のみを現在評価点に採用
    const acquiredOrSelectedByGroup = new Map<
      number,
      { skill: DetectedSkillItem; effectiveGrade: number }
    >();
    const candidateSkills: DetectedSkillItem[] = [];

    for (const skill of skills) {
      if (skill.isExcluded || excludedSet.has(skill.id)) continue;

      const master = this.masterStore.skillsById.get(skill.id);
      const distTypes = master ? master.distanceTypes : [];
      const runStyles = master ? master.runningStyles : [];
      const effGrade = calculateEffectiveGradeValue(
        skill.gradeValue,
        distTypes,
        runStyles,
        aptitudes
      );

      if (skill.state === 'acquired' || skill.state === 'selected') {
        const existing = acquiredOrSelectedByGroup.get(skill.groupId);
        if (
          !existing ||
          skill.groupRate > existing.skill.groupRate ||
          (skill.groupRate === existing.skill.groupRate && effGrade > existing.effectiveGrade)
        ) {
          acquiredOrSelectedByGroup.set(skill.groupId, { skill, effectiveGrade: effGrade });
        }
      } else {
        // 紫スキル（groupRate <= 0 || gradeValue <= 0）は除外
        if (skill.groupRate <= 0 || skill.gradeValue <= 0) continue;
        candidateSkills.push(skill);
      }
    }

    let currentGradeSum = 0;
    let acquiredSkillBonus = 0;
    for (const entry of acquiredOrSelectedByGroup.values()) {
      const master = this.masterStore.skillsById.get(entry.skill.id);
      // Why exclude body innate uniques: fixed Lv*170 innate unique grades belong to the separate
      // unique skill category in-game, not 到達想定スキル評価点.
      if (!isInnateUniqueSkill(master, entry.skill)) {
        currentGradeSum += entry.effectiveGrade;
      }
      if (isSkillTest && entry.skill.groupRate > 0 && entry.skill.gradeValue > 0) {
        acquiredSkillBonus += tierBonus(entry.skill.rarity);
      }
    }

    // candidateSkills の中に同グループの groupRate === 1 (○) があるか
    const unselectedGroupRate1Map = new Map<number, DetectedSkillItem>();
    for (const s of candidateSkills) {
      if (s.groupRate === 1) {
        unselectedGroupRate1Map.set(s.groupId, s);
      }
    }

    // シナリオ進化の最大枠数（実マスタで進化枠 0 の旧シナリオは 0、現行シナリオは最大 2）
    const scenario = selectedScenarioId
      ? this.masterStore.scenariosById.get(selectedScenarioId)
      : undefined;
    const maxScen = selectedScenarioId ? (scenario ? Math.min(2, scenario.skillUpgradeNum) : 2) : 0;

    // 2. 候補スキルの実効コスト・実効評価点（進化前提オプション含む）をグループ単位で構築
    const unlockedByGroup = new Map<number, DpOption[]>();
    const lockedByGroup = new Map<number, { groupRate: number; options: DpOption[] }>();

    for (const skill of candidateSkills) {
      const acquiredLower = acquiredOrSelectedByGroup.get(skill.groupId);
      // 既に同グループで同等以上の段階（◎や金スキル等）を取得・選択済みなら下位スキルをスキップ
      if (acquiredLower && skill.groupRate <= acquiredLower.skill.groupRate) {
        continue;
      }

      const master = this.masterStore.skillsById.get(skill.id);
      const distTypes = master ? master.distanceTypes : [];
      const runStyles = master ? master.runningStyles : [];
      const effGrade = calculateEffectiveGradeValue(
        skill.gradeValue,
        distTypes,
        runStyles,
        aptitudes
      );

      const baseGroupEff = acquiredLower ? acquiredLower.effectiveGrade : 0;
      let cost = skill.recognizedCost;
      let baseGain = Math.max(0, effGrade - baseGroupEff);

      // ◎系スキル (rarity === 1 && groupRate === 2)
      if (skill.rarity === 1 && skill.groupRate === 2) {
        const lowerUnselected = unselectedGroupRate1Map.get(skill.groupId);
        if (lowerUnselected) {
          // ○ も未取得候補にある場合: ◎ を取るには ○ のコスト + ◎ のコストが必要
          cost = lowerUnselected.recognizedCost + skill.recognizedCost;
          baseGain = Math.max(0, effGrade - baseGroupEff);
        } else {
          // ○ が selected / acquired、または候補にない場合: 下位スキルの実効評価点を差し引いて差分にする
          const groupSkills = this.masterStore.skillsByGroupId.get(skill.groupId);
          const lowerMaster = groupSkills ? groupSkills.find((s) => s.groupRate === 1) : undefined;
          const lowerMasterEff = lowerMaster
            ? calculateEffectiveGradeValue(
                lowerMaster.gradeValue,
                lowerMaster.distanceTypes,
                lowerMaster.runningStyles,
                aptitudes
              )
            : 0;
          const lowerEffGrade = Math.max(baseGroupEff, lowerMasterEff);
          baseGain = Math.max(0, effGrade - lowerEffGrade);
          cost = skill.recognizedCost;
        }
      }

      const isLocked = skill.isLocked || lockedSet.has(skill.id);
      const skillOptions: DpOption[] = [];
      const baseGroupBonus =
        isSkillTest &&
        acquiredLower &&
        acquiredLower.skill.groupRate > 0 &&
        acquiredLower.skill.gradeValue > 0
          ? tierBonus(acquiredLower.skill.rarity)
          : 0;

      const calcOptionValues = (optionEffectiveGrade: number, hasEvo: boolean) => {
        const bonusPoints = isSkillTest
          ? (hasEvo ? SKILL_TEST_BONUS.evolved : tierBonus(skill.rarity)) - baseGroupBonus
          : 0;
        const scoreValue = isSkillTest ? optionEffectiveGrade + bonusPoints : optionEffectiveGrade;
        return { bonusPoints, scoreValue };
      };

      const pushOption = (
        optionEffectiveGrade: number,
        needC3: 0 | 1,
        needC5: 0 | 1,
        needSc: 0 | 1,
        evoDetail?: EvoOptionDetail
      ): void => {
        const { bonusPoints, scoreValue } = calcOptionValues(optionEffectiveGrade, Boolean(evoDetail));
        skillOptions.push({
          skill,
          actualCost: cost,
          dpCost: isLocked ? 0 : cost,
          effectiveGrade: optionEffectiveGrade,
          bonusPoints,
          scoreValue,
          costPerformance: cost > 0 ? Number((scoreValue / cost).toFixed(2)) : 999,
          isLocked,
          needC3,
          needC5,
          needSc,
          evoDetail,
        });
      };

      const baseValues = calcOptionValues(baseGain, false);
      const successionEvoDetail =
        skill.rarity === 1 && skill.canEvolve
          ? this.collectSuccessionEvolutionDetail(
              skill.id,
              effGrade,
              selectedCardId,
              aptitudes,
              isSkillTest
            )
          : undefined;

      if (successionEvoDetail) {
        const evoGain = Math.max(0, successionEvoDetail.evoEff - baseGroupEff);
        const evoValues = calcOptionValues(evoGain, true);
        if (evoValues.scoreValue > baseValues.scoreValue || (isLocked && evoValues.scoreValue > 0)) {
          pushOption(evoGain, 0, 0, 0, successionEvoDetail);
        } else if (isLocked || baseValues.scoreValue > 0) {
          pushOption(baseGain, 0, 0, 0);
        }
      } else {
        if (isLocked || baseValues.scoreValue > 0) {
          pushOption(baseGain, 0, 0, 0);
        }

        if (skill.rarity === 2) {
          const evoDetails = this.collectGoldEvolutionDetails(
            skill.id,
            effGrade,
            selectedCardId,
            selectedScenarioId,
            maxScen,
            aptitudes,
            isSkillTest
          );
          for (const evoDetail of evoDetails) {
            const evoGain = Math.max(0, evoDetail.evoEff - baseGroupEff);
            const evoValues = calcOptionValues(evoGain, true);
            if (evoValues.scoreValue > baseValues.scoreValue || (isLocked && evoValues.scoreValue > 0)) {
              pushOption(
                evoGain,
                evoDetail.slotType === 'chara_lv3' ? 1 : 0,
                evoDetail.slotType === 'chara_lv5' ? 1 : 0,
                evoDetail.slotType === 'scenario' ? 1 : 0,
                evoDetail
              );
            }
          }
        }
      }

      if (skillOptions.length === 0) continue;

      if (isLocked) {
        const prevLocked = lockedByGroup.get(skill.groupId);
        if (!prevLocked || skill.groupRate > prevLocked.groupRate) {
          lockedByGroup.set(skill.groupId, { groupRate: skill.groupRate, options: skillOptions });
        }
      } else {
        const list = unlockedByGroup.get(skill.groupId) || [];
        list.push(...skillOptions);
        unlockedByGroup.set(skill.groupId, list);
      }
    }

    // 3. ロック（必須取得）スキルの予算確保 & DPグループ構築
    let remainingBudget = availableSp;
    const dpGroups: DpGroup[] = [];

    for (const lockedGroup of lockedByGroup.values()) {
      remainingBudget -= lockedGroup.options[0].actualCost;
      dpGroups.push({
        canSkip: false,
        isAcquiredGroup: false,
        options: lockedGroup.options,
      });
    }

    if (remainingBudget > 0) {
      for (const [groupId, groupOptions] of unlockedByGroup) {
        if (lockedByGroup.has(groupId)) continue;
        dpGroups.push({
          canSkip: true,
          isAcquiredGroup: false,
          options: groupOptions,
        });
      }
    }

    // 既取得・選択中の金スキルおよび継承進化スキルも進化枠・評価点増分の最適化に参加させる（SP消費 0）
    for (const [groupId, entry] of acquiredOrSelectedByGroup) {
      if (lockedByGroup.has(groupId)) continue;

      if (entry.skill.rarity === 1) {
        if (!entry.skill.canEvolve) continue;
        const succDetail = this.collectSuccessionEvolutionDetail(
          entry.skill.id,
          entry.effectiveGrade,
          selectedCardId,
          aptitudes,
          isSkillTest
        );
        if (!succDetail) continue;

        const bonusPoints = isSkillTest ? SKILL_TEST_BONUS.evolved - SKILL_TEST_BONUS.normal : 0;
        const scoreValue = isSkillTest ? succDetail.evoDelta + bonusPoints : succDetail.evoDelta;
        dpGroups.push({
          canSkip: false,
          isAcquiredGroup: true,
          options: [
            {
              skill: entry.skill,
              actualCost: 0,
              dpCost: 0,
              effectiveGrade: succDetail.evoDelta,
              bonusPoints,
              scoreValue,
              costPerformance: 999,
              isLocked: false,
              needC3: 0,
              needC5: 0,
              needSc: 0,
              evoDetail: succDetail,
            },
          ],
        });
        continue;
      }

      if (entry.skill.rarity !== 2) continue;
      const evoDetails = this.collectGoldEvolutionDetails(
        entry.skill.id,
        entry.effectiveGrade,
        selectedCardId,
        selectedScenarioId,
        maxScen,
        aptitudes,
        isSkillTest
      );
      if (evoDetails.length === 0) continue;

      const acquiredOptions: DpOption[] = evoDetails.map((evoDetail) => {
        const bonusPoints = isSkillTest ? SKILL_TEST_BONUS.evolved - SKILL_TEST_BONUS.rare : 0;
        const scoreValue = isSkillTest ? evoDetail.evoDelta + bonusPoints : evoDetail.evoDelta;
        return {
          skill: entry.skill,
          actualCost: 0,
          dpCost: 0,
          effectiveGrade: evoDetail.evoDelta,
          bonusPoints,
          scoreValue,
          costPerformance: 999,
          isLocked: false,
          needC3: evoDetail.slotType === 'chara_lv3' ? 1 : 0,
          needC5: evoDetail.slotType === 'chara_lv5' ? 1 : 0,
          needSc: evoDetail.slotType === 'scenario' ? 1 : 0,
          evoDetail,
        };
      });
      dpGroups.push({
        canSkip: true,
        isAcquiredGroup: true,
        options: acquiredOptions,
      });
    }

    // 4. 進化前提 12状態DP (c3 ∈ {0,1} × c5 ∈ {0,1} × sc ∈ {0..maxScen}) による最適化
    const finalRecommended: RecommendedSkill[] = [];
    const dpEvolutionAssignments = new Map<number, DpEvolutionAssignment>();
    let acquiredEvolutionBonus = 0;

    if (dpGroups.length > 0) {
      // Why not cap at 5000: modern scenarios reach 8000+ SP, and bounding by totalPossibleSp avoids wasted DP work on low skill counts
      let totalPossibleSp = 0;
      let maxGroupOptions = 0;
      for (const group of dpGroups) {
        if (group.options.length > maxGroupOptions) {
          maxGroupOptions = group.options.length;
        }
        let groupMaxCost = 0;
        for (const opt of group.options) {
          if (opt.dpCost > 0 && opt.dpCost <= remainingBudget && opt.dpCost > groupMaxCost) {
            groupMaxCost = opt.dpCost;
          }
        }
        totalPossibleSp += groupMaxCost;
      }

      const maxSp = Math.max(0, Math.min(remainingBudget, totalPossibleSp, 30000));
      const numSc = maxScen + 1;
      const numStates = 4 * numSc;
      const stride = maxSp + 1;

      let dp = new Int32Array(numStates * stride).fill(-1);
      let nextDp = new Int32Array(numStates * stride);
      let stateMaxSp = new Int32Array(numStates).fill(-1);
      let nextStateMaxSp = new Int32Array(numStates);
      dp[0] = 0;
      stateMaxSp[0] = 0;

      const backtrack =
        maxGroupOptions <= 127
          ? new Int8Array(dpGroups.length * numStates * stride).fill(-1)
          : new Int16Array(dpGroups.length * numStates * stride).fill(-1);

      for (let g = 0; g < dpGroups.length; g++) {
        const group = dpGroups[g];
        const groupOffset = g * numStates * stride;

        if (group.canSkip) {
          nextDp.set(dp);
          nextStateMaxSp.set(stateMaxSp);
        } else {
          nextDp.fill(-1);
          nextStateMaxSp.fill(-1);
        }

        for (let optIdx = 0; optIdx < group.options.length; optIdx++) {
          const opt = group.options[optIdx];
          const cost = opt.dpCost;
          if (cost > maxSp) continue;
          const gain = opt.scoreValue;

          for (let c3 = opt.needC3; c3 <= 1; c3++) {
            const prevC3 = c3 - opt.needC3;
            for (let c5 = opt.needC5; c5 <= 1; c5++) {
              const prevC5 = c5 - opt.needC5;
              for (let sc = opt.needSc; sc <= maxScen; sc++) {
                const prevSc = sc - opt.needSc;
                const prevState = (prevC3 * 2 + prevC5) * numSc + prevSc;
                const prevMax = stateMaxSp[prevState];
                if (prevMax < 0) continue;

                const limitSp = Math.min(prevMax, maxSp - cost);
                if (limitSp < 0) continue;

                const state = (c3 * 2 + c5) * numSc + sc;
                const prevOffset = prevState * stride;
                const stateOffset = state * stride;
                let maxReachedSp = nextStateMaxSp[state];

                for (let sp = 0; sp <= limitSp; sp++) {
                  const baseGrade = dp[prevOffset + sp];
                  if (baseGrade < 0) continue;

                  const nextSp = sp + cost;
                  const nextGrade = baseGrade + gain;
                  if (nextGrade > nextDp[stateOffset + nextSp]) {
                    nextDp[stateOffset + nextSp] = nextGrade;
                    backtrack[groupOffset + stateOffset + nextSp] = optIdx;
                    if (nextSp > maxReachedSp) {
                      maxReachedSp = nextSp;
                    }
                  }
                }

                nextStateMaxSp[state] = maxReachedSp;
              }
            }
          }
        }

        const tmpDp = dp;
        dp = nextDp;
        nextDp = tmpDp;

        const tmpMaxSp = stateMaxSp;
        stateMaxSp = nextStateMaxSp;
        nextStateMaxSp = tmpMaxSp;
      }

      let bestGrade = -1;
      let bestState = 0;
      let bestSp = 0;
      for (let state = 0; state < numStates; state++) {
        const reached = stateMaxSp[state];
        if (reached < 0) continue;
        const offset = state * stride;
        for (let sp = 0; sp <= reached; sp++) {
          const val = dp[offset + sp];
          if (val > bestGrade || (val === bestGrade && sp < bestSp)) {
            bestGrade = val;
            bestState = state;
            bestSp = sp;
          }
        }
      }

      let currState = bestState;
      let currSp = bestSp;
      for (let g = dpGroups.length - 1; g >= 0; g--) {
        const group = dpGroups[g];
        const optIdx = backtrack[g * numStates * stride + currState * stride + currSp];
        if (optIdx >= 0) {
          const chosen = group.options[optIdx];
          if (chosen.evoDetail) {
            dpEvolutionAssignments.set(chosen.skill.id, {
              isAcquired: group.isAcquiredGroup,
              evoDetail: chosen.evoDetail,
            });
          }

          if (!group.isAcquiredGroup) {
            const rec: RecommendedSkill = {
              skill: chosen.skill,
              effectiveCost: chosen.actualCost,
              effectiveGrade: chosen.effectiveGrade,
              costPerformance: chosen.costPerformance,
              reason: this.formatRecommendationReason(chosen),
            };
            if (isSkillTest) {
              rec.bonusPoints = chosen.bonusPoints;
              rec.scoreGain = chosen.scoreValue;
            }
            finalRecommended.push(rec);
          } else if (isSkillTest && chosen.evoDetail) {
            acquiredEvolutionBonus += chosen.bonusPoints;
          }

          currSp -= chosen.dpCost;
          const sc = currState % numSc;
          const cRem = (currState - sc) / numSc;
          const c5 = cRem % 2;
          const c3 = (cRem - c5) / 2;
          currState =
            ((c3 - chosen.needC3) * 2 + (c5 - chosen.needC5)) * numSc + (sc - chosen.needSc);
        }
      }
    }

    // コスパ順ソート
    finalRecommended.sort((a, b) => b.costPerformance - a.costPerformance);

    // 5. 進化スキルの推奨ガイド生成（DP のスロット最適割当と整合）
    const acquiredOrRecommendedIds = new Set<number>();
    for (const s of skills) {
      if (!s.isExcluded && !excludedSet.has(s.id) && (s.state === 'acquired' || s.state === 'selected')) {
        acquiredOrRecommendedIds.add(s.id);
      }
    }
    for (const r of finalRecommended) {
      acquiredOrRecommendedIds.add(r.skill.id);
    }

    const evolutionRecommendations = this.generateEvolutionRecommendations(
      acquiredOrRecommendedIds,
      dpEvolutionAssignments,
      selectedCardId,
      selectedScenarioId,
      maxScen,
      aptitudes
    );

    if (isSkillTest) {
      for (const rec of evolutionRecommendations) {
        if (!rec.canEvolve) continue;
        const assigned = dpEvolutionAssignments.get(rec.baseSkillId);
        if (!assigned || assigned.evoDetail.slotType !== rec.slotType) continue;
        const baseMaster = this.masterStore.skillsById.get(rec.baseSkillId);
        const baseRarity = baseMaster ? baseMaster.rarity : rec.slotType === 'succession' ? 1 : 2;
        rec.scoreDelta =
          assigned.evoDetail.evoDelta + (SKILL_TEST_BONUS.evolved - tierBonus(baseRarity));
      }
    }

    // 既取得・選択中スキルの進化増分のみを加算（推奨スキルの進化増分は r.effectiveGrade に計上済みのため二重加算しない）
    let evolutionGradeBonus = 0;
    for (const assignment of dpEvolutionAssignments.values()) {
      if (assignment.isAcquired) {
        evolutionGradeBonus += assignment.evoDetail.evoDelta;
      }
    }

    const spentSp = finalRecommended.reduce((acc, r) => acc + r.effectiveCost, 0);
    const skillsGain = finalRecommended.reduce((acc, r) => acc + r.effectiveGrade, 0);
    const totalAdditionalGrade = skillsGain + evolutionGradeBonus;
    const maxGradeValue = currentGradeSum + totalAdditionalGrade;

    const result: SolverResult = {
      maxGradeValue,
      totalAdditionalGrade,
      spentSp,
      remainingSp: Math.max(0, availableSp - spentSp),
      recommendedSkills: finalRecommended,
      evolutionRecommendations,
    };

    if (isSkillTest) {
      const recommendedBonus = finalRecommended.reduce((acc, r) => acc + (r.bonusPoints ?? 0), 0);
      const skillBonusTotal = acquiredSkillBonus + recommendedBonus + acquiredEvolutionBonus;
      result.skillBonusTotal = skillBonusTotal;
      result.scoreBreakdown = {
        gradeValue: maxGradeValue,
        skillBonus: skillBonusTotal,
        total: maxGradeValue + skillBonusTotal,
      };
    }

    return result;
  }

  private formatRecommendationReason(option: DpOption): string | undefined {
    if (option.isLocked) {
      return '必須取得（ロック中）';
    }
    return undefined;
  }

  private findBestCharaEvolution(
    evosForRank: CharaEvolutionItem[],
    baseEff: number,
    aptitudes: AptitudeState
  ): { evolvedSkill: SkillMasterItem; evoEff: number; gain: number } | undefined {
    let bestEvo: SkillMasterItem | undefined;
    let bestEvoEff = 0;
    let bestGain = -Infinity;

    for (const evoItem of evosForRank) {
      const evolved = this.masterStore.skillsById.get(evoItem.evolvedSkillId);
      if (!evolved) continue;

      const evoEff = calculateEffectiveGradeValue(
        evolved.gradeValue,
        evolved.distanceTypes,
        evolved.runningStyles,
        aptitudes
      );
      const gain = evoEff - baseEff;
      if (gain > bestGain) {
        bestGain = gain;
        bestEvoEff = evoEff;
        bestEvo = evolved;
      }
    }

    if (!bestEvo) return undefined;
    return { evolvedSkill: bestEvo, evoEff: bestEvoEff, gain: bestGain };
  }

  private collectSuccessionEvolutionDetail(
    skillId: number,
    baseEff: number,
    cardId: number | undefined,
    aptitudes: AptitudeState,
    isSkillTest = false
  ): EvoOptionDetail | undefined {
    const succEvos = this.masterStore.successionEvolutionsByBaseSkillId.get(skillId);
    if (!succEvos || succEvos.length === 0) return undefined;

    const bonusDelta = isSkillTest ? SKILL_TEST_BONUS.evolved - SKILL_TEST_BONUS.normal : 0;
    let bestEvo: SkillMasterItem | undefined;
    let bestEvoEff = 0;
    let bestDelta = -bonusDelta;

    for (const evoItem of succEvos) {
      if (cardId !== undefined && cardId > 0 && evoItem.cardId === cardId) continue;
      const evolvedSkill = this.masterStore.skillsById.get(evoItem.evolvedSkillId);
      if (!evolvedSkill) continue;

      const evoEff = calculateEffectiveGradeValue(
        evolvedSkill.gradeValue,
        evolvedSkill.distanceTypes,
        evolvedSkill.runningStyles,
        aptitudes
      );
      const delta = evoEff - baseEff;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestEvoEff = evoEff;
        bestEvo = evolvedSkill;
      }
    }

    if (!bestEvo) return undefined;
    return {
      slotType: 'succession',
      evolvedSkill: bestEvo,
      evoEff: bestEvoEff,
      baseEff,
      evoDelta: bestDelta,
    };
  }

  private collectGoldEvolutionDetails(
    skillId: number,
    goldEff: number,
    cardId: number | undefined,
    scenarioId: number | undefined,
    maxScen: number,
    aptitudes: AptitudeState,
    isSkillTest = false
  ): EvoOptionDetail[] {
    const details: EvoOptionDetail[] = [];
    const bonusDelta = isSkillTest ? SKILL_TEST_BONUS.evolved - SKILL_TEST_BONUS.rare : 0;

    if (cardId) {
      const charaEvos = this.masterStore.charaEvolutionsByCardId.get(cardId) || [];
      for (const rank of [3, 5] as const) {
        const evosForRank = charaEvos.filter((e) => e.slotRank === rank && e.baseSkillId === skillId);
        if (evosForRank.length === 0) continue;

        const best = this.findBestCharaEvolution(evosForRank, goldEff, aptitudes);
        if (best && best.gain + bonusDelta > 0) {
          details.push({
            slotType: rank === 3 ? 'chara_lv3' : 'chara_lv5',
            evolvedSkill: best.evolvedSkill,
            evoEff: best.evoEff,
            baseEff: goldEff,
            evoDelta: best.gain,
          });
        }
      }
    }

    if (scenarioId && maxScen > 0) {
      const scEvos = this.masterStore.scenarioEvolutionsByScenarioId.get(scenarioId) || [];
      const scenEvo = scEvos.find((e) => e.baseSkillId === skillId);
      if (scenEvo) {
        const evolvedSkill = this.masterStore.skillsById.get(scenEvo.evolvedSkillId);
        if (evolvedSkill) {
          const evoEff = calculateEffectiveGradeValue(
            evolvedSkill.gradeValue,
            evolvedSkill.distanceTypes,
            evolvedSkill.runningStyles,
            aptitudes
          );
          const gain = evoEff - goldEff;
          if (gain + bonusDelta > 0) {
            details.push({
              slotType: 'scenario',
              evolvedSkill,
              evoEff,
              baseEff: goldEff,
              evoDelta: gain,
            });
          }
        }
      }
    }

    return details;
  }

  /**
   * DP で最適割当された自前進化（覚醒Lv3, Lv5）、シナリオ進化、および継承進化の推奨ガイドを生成
   */
  private generateEvolutionRecommendations(
    acquiredOrRecommendedIds: Set<number>,
    dpEvolutionAssignments: Map<number, DpEvolutionAssignment>,
    cardId: number | undefined,
    scenarioId: number | undefined,
    maxScen: number,
    aptitudes: AptitudeState
  ): EvolutionRecommendation[] {
    const results: EvolutionRecommendation[] = [];

    // 1. 自前進化 (覚醒Lv3, Lv5)
    if (cardId) {
      const charaEvos = this.masterStore.charaEvolutionsByCardId.get(cardId) || [];

      for (const rank of [3, 5] as const) {
        const evosForRank = charaEvos.filter((e) => e.slotRank === rank);
        if (evosForRank.length === 0) continue;

        const baseSkillId = evosForRank[0].baseSkillId;
        const baseSkill = this.masterStore.skillsById.get(baseSkillId);
        const baseName = baseSkill ? baseSkill.name : `スキル #${baseSkillId}`;
        const hasBaseSkill = acquiredOrRecommendedIds.has(baseSkillId);

        const baseEff = baseSkill
          ? calculateEffectiveGradeValue(
              baseSkill.gradeValue,
              baseSkill.distanceTypes,
              baseSkill.runningStyles,
              aptitudes
            )
          : 0;

        const best = this.findBestCharaEvolution(evosForRank, baseEff, aptitudes);
        const slotType = rank === 3 ? 'chara_lv3' : 'chara_lv5';
        const assigned = dpEvolutionAssignments.get(baseSkillId);

        let canEvolve = false;
        let evolvedSkill = best?.evolvedSkill;
        let recommendationNote: string;

        if (assigned && assigned.evoDetail.slotType === slotType) {
          canEvolve = true;
          evolvedSkill = assigned.evoDetail.evolvedSkill;
          recommendationNote =
            evosForRank.length > 1
              ? `推奨分岐: 「${evolvedSkill.name}」(+${assigned.evoDetail.evoDelta} pt)`
              : `進化推奨 (+${assigned.evoDetail.evoDelta} pt)`;
        } else if (assigned && assigned.evoDetail.slotType === 'scenario') {
          recommendationNote = 'シナリオ進化を優先（重複進化不可）';
        } else if (!hasBaseSkill) {
          recommendationNote = `進化元「${baseName}」の取得が必要`;
        } else {
          recommendationNote = best
            ? `適性低下のため進化見送り（金のまま ${baseEff} pt 維持）`
            : '進化条件未達成';
        }

        results.push({
          slotType,
          slotName: `自前覚醒 Lv${rank}`,
          baseSkillName: baseName,
          baseSkillId,
          evolvedSkill,
          canEvolve,
          recommendationNote,
        });
      }
    }

    // 2. シナリオ進化（DP で割当された最大2枠）
    if (scenarioId && maxScen > 0) {
      const scEvos = this.masterStore.scenarioEvolutionsByScenarioId.get(scenarioId) || [];
      let evolvedCount = 0;

      for (const evoItem of scEvos) {
        if (evolvedCount >= maxScen) break;
        const assigned = dpEvolutionAssignments.get(evoItem.baseSkillId);
        if (!assigned || assigned.evoDetail.slotType !== 'scenario') continue;

        const baseSkill = this.masterStore.skillsById.get(evoItem.baseSkillId);
        const baseName = baseSkill ? baseSkill.name : `スキル #${evoItem.baseSkillId}`;
        const { evolvedSkill, evoDelta } = assigned.evoDetail;

        evolvedCount++;
        results.push({
          slotType: 'scenario',
          slotName: `シナリオ進化枠 ${evolvedCount}/${maxScen}`,
          baseSkillName: baseName,
          baseSkillId: evoItem.baseSkillId,
          evolvedSkill,
          canEvolve: true,
          recommendationNote: `「${evolvedSkill.name}」へ無料進化推奨 (+${evoDelta} pt)`,
        });
      }
    }

    // 3. 継承進化（DP で割当された継承進化スキル）
    for (const baseSkillId of this.masterStore.successionEvolutionsByBaseSkillId.keys()) {
      const assigned = dpEvolutionAssignments.get(baseSkillId);
      if (!assigned || assigned.evoDetail.slotType !== 'succession') continue;

      const baseSkill = this.masterStore.skillsById.get(baseSkillId);
      const baseName = baseSkill ? baseSkill.name : `スキル #${baseSkillId}`;
      const { evolvedSkill, evoDelta } = assigned.evoDetail;

      results.push({
        slotType: 'succession',
        slotName: '継承進化',
        baseSkillName: baseName,
        baseSkillId,
        evolvedSkill,
        canEvolve: true,
        recommendationNote: `「${evolvedSkill.name}」へ継承進化 (+${evoDelta} pt)`,
      });
    }

    return results;
  }
}
