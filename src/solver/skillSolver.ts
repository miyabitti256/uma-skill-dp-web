import type { ISkillSolver } from './solverInterface.ts';
import type {
  SolverOptions,
  SolverResult,
  RecommendedSkill,
  EvolutionRecommendation,
} from '../types/solver.ts';
import type { DetectedSkillItem, AptitudeState, AptitudeRank } from '../types/recognition.ts';
import { MasterStore } from '../data/masterStore.ts';
import type { CharaEvolutionItem, SkillConditionRequirement, SkillMasterItem } from '../types/master.ts';

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

interface ReqCondition {
  mask: number;
  requiredNewCount: number;
}

interface EvoOptionDetail {
  slotType: 'chara_lv3' | 'chara_lv5' | 'chara_lv7' | 'scenario' | 'succession';
  evolvedSkill: SkillMasterItem;
  evoEff: number;
  baseEff: number;
  evoDelta: number;
  reqConditions?: ReqCondition[];
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
  needSc: 0 | 1;
  optNewMask: number;
  reqConditions?: ReqCondition[];
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

interface PreparedCandidate {
  skill: DetectedSkillItem;
  master: SkillMasterItem | undefined;
  effGrade: number;
  cost: number;
  baseGain: number;
  baseGroupEff: number;
  isLocked: boolean;
  optNewMask: number;
  hasBadge: boolean;
}

export class TypeScriptSkillSolver implements ISkillSolver {
  private masterStore: MasterStore;

  constructor(masterStore?: MasterStore) {
    this.masterStore = masterStore || MasterStore.getInstance();
  }

  public solve(skills: DetectedSkillItem[], options: SolverOptions): SolverResult {
    const { availableSp, aptitudes, selectedCardId, selectedScenarioId } = options;
    const maxAwakeningRank = options.awakeningLevel ?? 7;
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
    let hasNormalWhiteSkillsInInput = false;

    for (const skill of skills) {
      if (skill.isExcluded || excludedSet.has(skill.id)) continue;

      if (skill.rarity === 1 && skill.id < 900000) {
        hasNormalWhiteSkillsInInput = true;
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
    const baseOwnedMasks: number[] = [];
    const lowerOwnedMaskByGroup = new Map<number, number>();
    for (const [groupId, entry] of acquiredOrSelectedByGroup) {
      const master = this.masterStore.skillsById.get(entry.skill.id);
      const condMask = master?.conditionMask ?? 0;
      baseOwnedMasks.push(condMask);
      lowerOwnedMaskByGroup.set(groupId, condMask);

      // Why exclude body innate uniques: fixed Lv*170 innate unique grades belong to the separate
      // unique skill category in-game, not 到達想定スキル評価点.
      if (!isInnateUniqueSkill(master, entry.skill)) {
        currentGradeSum += entry.effectiveGrade;
      }
      if (isSkillTest && entry.skill.groupRate > 0 && entry.skill.gradeValue > 0) {
        acquiredSkillBonus += tierBonus(entry.skill.rarity);
      }
    }

    // 育成ウマ娘本人の初期固有スキルも進化条件の所持数カウント対象に含める
    if (selectedCardId) {
      const card = this.masterStore.cardsById.get(selectedCardId);
      if (card && card.uniqueSkillId > 0) {
        const uniqueMaster = this.masterStore.skillsById.get(card.uniqueSkillId);
        if (uniqueMaster && !acquiredOrSelectedByGroup.has(uniqueMaster.groupId)) {
          baseOwnedMasks.push(uniqueMaster.conditionMask ?? 0);
        }
      }
    }

    const countBaseOwned = (mask: number): number => {
      let count = 0;
      for (const m of baseOwnedMasks) {
        if ((m & mask) !== 0) count++;
      }
      return count;
    };

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

    // 2. 候補スキルの前処理と供給可能マスク集計（進化条件判定前に全候補の供給数を確定）
    const preparedCandidates: PreparedCandidate[] = [];
    const lockedCandidateByGroup = new Map<number, PreparedCandidate>();

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
      const lowerOwnedMask = lowerOwnedMaskByGroup.get(skill.groupId) ?? 0;
      const optNewMask = (master?.conditionMask ?? 0) & ~lowerOwnedMask;
      const hasBadge = skill.hasEvoBadge !== undefined ? skill.hasEvoBadge : skill.canEvolve;
      const cand: PreparedCandidate = {
        skill,
        master,
        effGrade,
        cost,
        baseGain,
        baseGroupEff,
        isLocked,
        optNewMask,
        hasBadge,
      };
      preparedCandidates.push(cand);

      if (isLocked) {
        const prevLocked = lockedCandidateByGroup.get(skill.groupId);
        if (!prevLocked || skill.groupRate > prevLocked.skill.groupRate) {
          lockedCandidateByGroup.set(skill.groupId, cand);
        }
      }
    }

    let remainingBudget = availableSp;
    const groupSupplyMask = new Map<number, number>();
    for (const [groupId, lockedCand] of lockedCandidateByGroup) {
      remainingBudget -= lockedCand.cost;
      if (lockedCand.optNewMask !== 0) {
        groupSupplyMask.set(groupId, lockedCand.optNewMask);
      }
    }
    if (remainingBudget > 0) {
      for (const cand of preparedCandidates) {
        if (cand.isLocked || lockedCandidateByGroup.has(cand.skill.groupId)) continue;
        if (cand.cost > remainingBudget || cand.optNewMask === 0) continue;
        const prev = groupSupplyMask.get(cand.skill.groupId) ?? 0;
        groupSupplyMask.set(cand.skill.groupId, prev | cand.optNewMask);
      }
    }

    const maxOtherNewAvailable = (mask: number, excludeGroupId: number): number => {
      let count = 0;
      for (const [gid, supplyMask] of groupSupplyMask) {
        if (gid === excludeGroupId) continue;
        if ((supplyMask & mask) !== 0) count++;
      }
      return count;
    };

    // 2b. 候補スキルのオプション構築（通常 + 進化前提オプション）
    const unlockedByGroup = new Map<number, DpOption[]>();
    const lockedByGroup = new Map<number, { groupRate: number; options: DpOption[] }>();

    for (const cand of preparedCandidates) {
      const { skill, effGrade, cost, baseGain, baseGroupEff, isLocked, optNewMask, hasBadge } =
        cand;
      const acquiredLower = acquiredOrSelectedByGroup.get(skill.groupId);
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
          needSc,
          optNewMask,
          reqConditions: evoDetail?.reqConditions,
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
          pushOption(evoGain, 0, successionEvoDetail);
        } else if (isLocked || baseValues.scoreValue > 0) {
          pushOption(baseGain, 0);
        }
      } else {
        if (isLocked || baseValues.scoreValue > 0) {
          pushOption(baseGain, 0);
        }

        if (skill.rarity === 2) {
          const evoDetails = this.collectGoldEvolutionDetails(
            skill.id,
            effGrade,
            selectedCardId,
            selectedScenarioId,
            maxAwakeningRank,
            maxScen,
            aptitudes,
            isSkillTest,
            hasBadge,
            hasNormalWhiteSkillsInInput,
            skill.groupId,
            optNewMask,
            countBaseOwned,
            maxOtherNewAvailable
          );
          for (const evoDetail of evoDetails) {
            const evoGain = Math.max(0, evoDetail.evoEff - baseGroupEff);
            const evoValues = calcOptionValues(evoGain, true);
            if (evoValues.scoreValue > baseValues.scoreValue || (isLocked && evoValues.scoreValue > 0)) {
              pushOption(evoGain, evoDetail.slotType === 'scenario' ? 1 : 0, evoDetail);
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

    // 3. ロック（必須取得）スキル & DPグループ構築
    const dpGroups: DpGroup[] = [];

    for (const lockedGroup of lockedByGroup.values()) {
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
              needSc: 0,
              optNewMask: 0,
              evoDetail: succDetail,
            },
          ],
        });
        continue;
      }

      if (entry.skill.rarity !== 2) continue;
      const hasBadge =
        entry.skill.hasEvoBadge !== undefined ? entry.skill.hasEvoBadge : entry.skill.canEvolve;
      const evoDetails = this.collectGoldEvolutionDetails(
        entry.skill.id,
        entry.effectiveGrade,
        selectedCardId,
        selectedScenarioId,
        maxAwakeningRank,
        maxScen,
        aptitudes,
        isSkillTest,
        hasBadge,
        hasNormalWhiteSkillsInInput,
        groupId,
        0,
        countBaseOwned,
        maxOtherNewAvailable
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
          needSc: evoDetail.slotType === 'scenario' ? 1 : 0,
          optNewMask: 0,
          reqConditions: evoDetail.reqConditions,
          evoDetail,
        };
      });
      dpGroups.push({
        canSkip: true,
        isAcquiredGroup: true,
        options: acquiredOptions,
      });
    }

    // 4. 2段階DP（無条件グループ + 条件付き進化グループ）による最適割当
    const { finalRecommended, dpEvolutionAssignments, acquiredEvolutionBonus } =
      this.solveOptimalDp(dpGroups, remainingBudget, maxScen, isSkillTest);

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
      maxAwakeningRank,
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

  private solveOptimalDp(
    dpGroups: DpGroup[],
    remainingBudget: number,
    maxScen: number,
    isSkillTest: boolean
  ): {
    finalRecommended: RecommendedSkill[];
    dpEvolutionAssignments: Map<number, DpEvolutionAssignment>;
    acquiredEvolutionBonus: number;
  } {
    const finalRecommended: RecommendedSkill[] = [];
    const dpEvolutionAssignments = new Map<number, DpEvolutionAssignment>();
    let acquiredEvolutionBonus = 0;

    if (dpGroups.length === 0) {
      return { finalRecommended, dpEvolutionAssignments, acquiredEvolutionBonus };
    }

    // Why not cap at 5000: modern scenarios reach 8000+ SP, and bounding by totalPossibleSp avoids wasted DP work on low skill counts
    let totalPossibleSp = 0;
    for (const group of dpGroups) {
      let groupMaxCost = 0;
      for (const opt of group.options) {
        if (opt.dpCost > 0 && opt.dpCost <= remainingBudget && opt.dpCost > groupMaxCost) {
          groupMaxCost = opt.dpCost;
        }
      }
      totalPossibleSp += groupMaxCost;
    }
    const maxSp = Math.max(0, Math.min(remainingBudget, totalPossibleSp, 30000));

    const normalGroups: DpGroup[] = [];
    const condEvoGroups: DpGroup[] = [];
    for (const group of dpGroups) {
      if (group.options.some((opt) => opt.reqConditions && opt.reqConditions.length > 0)) {
        condEvoGroups.push(group);
      } else {
        normalGroups.push(group);
      }
    }

    const maxReqCountByMask = new Map<number, number>();
    for (const group of condEvoGroups) {
      for (const opt of group.options) {
        if (!opt.reqConditions) continue;
        for (const req of opt.reqConditions) {
          const prev = maxReqCountByMask.get(req.mask) ?? 0;
          if (req.requiredNewCount > prev) {
            maxReqCountByMask.set(req.mask, req.requiredNewCount);
          }
        }
      }
    }
    const activeMasks = Array.from(maxReqCountByMask.keys()).sort((a, b) => a - b);
    const numCondDims = activeMasks.length;
    let unionActiveMask = 0;
    for (const m of activeMasks) unionActiveMask |= m;

    // 状態次元を一切変化させない pureNormalGroups は 1次元ナップサックに分離して状態数爆発を防ぐ
    const pureNormalGroups: DpGroup[] = [];
    const stateChangingNormalGroups: DpGroup[] = [];
    for (const group of normalGroups) {
      const touchesState = group.options.some(
        (opt) => opt.needSc > 0 || (opt.optNewMask & unionActiveMask) !== 0
      );
      if (touchesState) {
        stateChangingNormalGroups.push(group);
      } else {
        pureNormalGroups.push(group);
      }
    }

    // 4a. pureNormalGroups 1D ナップサック DP
    let totalPureSp = 0;
    let maxPureOpts = 0;
    for (const group of pureNormalGroups) {
      if (group.options.length > maxPureOpts) maxPureOpts = group.options.length;
      let gMax = 0;
      for (const opt of group.options) {
        if (opt.dpCost > 0 && opt.dpCost <= maxSp && opt.dpCost > gMax) gMax = opt.dpCost;
      }
      totalPureSp += gMax;
    }
    const pureMaxSp = Math.min(maxSp, totalPureSp);
    const pureStride = pureMaxSp + 1;
    let pureDp = new Int32Array(pureStride).fill(-1);
    let nextPureDp = new Int32Array(pureStride);
    pureDp[0] = 0;
    let pureMaxReachedSp = 0;

    const pureBacktrack =
      pureNormalGroups.length > 0
        ? maxPureOpts <= 127
          ? new Int8Array(pureNormalGroups.length * pureStride).fill(-1)
          : new Int16Array(pureNormalGroups.length * pureStride).fill(-1)
        : new Int8Array(0);

    for (let g = 0; g < pureNormalGroups.length; g++) {
      const group = pureNormalGroups[g];
      const gOffset = g * pureStride;
      let nextPureMaxReached = -1;
      if (group.canSkip) {
        nextPureDp.set(pureDp);
        nextPureMaxReached = pureMaxReachedSp;
      } else {
        nextPureDp.fill(-1);
      }

      for (let optIdx = 0; optIdx < group.options.length; optIdx++) {
        const opt = group.options[optIdx];
        const cost = opt.dpCost;
        if (cost > pureMaxSp) continue;
        const limitSp = Math.min(pureMaxReachedSp, pureMaxSp - cost);
        for (let sp = 0; sp <= limitSp; sp++) {
          const base = pureDp[sp];
          if (base < 0) continue;
          const nextSp = sp + cost;
          const nextGrade = base + opt.scoreValue;
          if (nextGrade > nextPureDp[nextSp]) {
            nextPureDp[nextSp] = nextGrade;
            pureBacktrack[gOffset + nextSp] = optIdx;
            if (nextSp > nextPureMaxReached) nextPureMaxReached = nextSp;
          }
        }
      }

      const tmp = pureDp;
      pureDp = nextPureDp;
      nextPureDp = tmp;
      pureMaxReachedSp = nextPureMaxReached;
    }

    const prefixBestPureScore = new Int32Array(pureStride).fill(-1);
    const prefixBestPureSp = new Int32Array(pureStride).fill(0);
    let curPureBest = -1;
    let curPureBestSp = 0;
    for (let sp = 0; sp < pureStride; sp++) {
      const val = pureDp[sp];
      if (val > curPureBest) {
        curPureBest = val;
        curPureBestSp = sp;
      }
      prefixBestPureScore[sp] = curPureBest;
      prefixBestPureSp[sp] = curPureBestSp;
    }

    // 4b. stateChangingNormalGroups 多次元状態 DP: (sc, c_0 .. c_{d-1})
    const stateDimCaps = activeMasks.map((mask) => {
      const reqCap = maxReqCountByMask.get(mask)!;
      let supplyCnt = 0;
      for (const group of stateChangingNormalGroups) {
        if (group.options.some((opt) => (opt.optNewMask & mask) !== 0)) {
          supplyCnt++;
        }
      }
      return Math.min(reqCap, supplyCnt);
    });

    const condStrides = new Int32Array(numCondDims);
    let stateMultiplier = 1;
    for (let j = numCondDims - 1; j >= 0; j--) {
      condStrides[j] = stateMultiplier;
      stateMultiplier *= stateDimCaps[j] + 1;
    }
    const scStride = stateMultiplier;
    const numSc = maxScen + 1;
    const numStates = numSc * scStride;

    let totalStateSp = 0;
    let maxStateOpts = 0;
    for (const group of stateChangingNormalGroups) {
      if (group.options.length > maxStateOpts) maxStateOpts = group.options.length;
      let gMax = 0;
      for (const opt of group.options) {
        if (opt.dpCost > 0 && opt.dpCost <= maxSp && opt.dpCost > gMax) gMax = opt.dpCost;
      }
      totalStateSp += gMax;
    }
    const stateMaxSpLimit = Math.min(maxSp, totalStateSp);
    const stateStride = stateMaxSpLimit + 1;

    let stateDp = new Int32Array(numStates * stateStride).fill(-1);
    let nextStateDp = new Int32Array(numStates * stateStride);
    let stateMaxSp = new Int32Array(numStates).fill(-1);
    let nextStateMaxSp = new Int32Array(numStates);
    stateDp[0] = 0;
    stateMaxSp[0] = 0;

    const backtrackRows: Array<(Int8Array | Int16Array) | undefined> = new Array(
      stateChangingNormalGroups.length * numStates
    );
    const prevStateRows: Array<Int32Array | undefined> = new Array(
      stateChangingNormalGroups.length * numStates
    );

    for (let g = 0; g < stateChangingNormalGroups.length; g++) {
      const group = stateChangingNormalGroups[g];
      const gRowBase = g * numStates;

      if (group.canSkip) {
        nextStateDp.set(stateDp);
        nextStateMaxSp.set(stateMaxSp);
      } else {
        nextStateDp.fill(-1);
        nextStateMaxSp.fill(-1);
      }

      for (let optIdx = 0; optIdx < group.options.length; optIdx++) {
        const opt = group.options[optIdx];
        const cost = opt.dpCost;
        if (cost > stateMaxSpLimit) continue;
        const gain = opt.scoreValue;
        const optHits = activeMasks.map((m) => ((opt.optNewMask & m) !== 0 ? 1 : 0));

        for (let prevState = 0; prevState < numStates; prevState++) {
          const prevMax = stateMaxSp[prevState];
          if (prevMax < 0) continue;
          const limitSp = Math.min(prevMax, stateMaxSpLimit - cost);
          if (limitSp < 0) continue;

          const prevSc = Math.floor(prevState / scStride);
          const nextSc = prevSc + opt.needSc;
          if (nextSc > maxScen) continue;

          let nextState = nextSc * scStride;
          let rem = prevState - prevSc * scStride;
          for (let j = 0; j < numCondDims; j++) {
            const cStride = condStrides[j];
            const prevC = Math.floor(rem / cStride);
            rem -= prevC * cStride;
            const nextC = Math.min(stateDimCaps[j], prevC + optHits[j]);
            nextState += nextC * cStride;
          }

          const prevOffset = prevState * stateStride;
          const nextOffset = nextState * stateStride;
          let maxReachedSp = nextStateMaxSp[nextState];
          let btRow = backtrackRows[gRowBase + nextState];
          let psRow = prevStateRows[gRowBase + nextState];

          for (let sp = 0; sp <= limitSp; sp++) {
            const baseGrade = stateDp[prevOffset + sp];
            if (baseGrade < 0) continue;

            const nextSp = sp + cost;
            const nextGrade = baseGrade + gain;
            if (nextGrade > nextStateDp[nextOffset + nextSp]) {
              nextStateDp[nextOffset + nextSp] = nextGrade;
              if (!btRow) {
                btRow =
                  maxStateOpts <= 127
                    ? new Int8Array(stateStride).fill(-1)
                    : new Int16Array(stateStride).fill(-1);
                psRow = new Int32Array(stateStride).fill(-1);
                backtrackRows[gRowBase + nextState] = btRow;
                prevStateRows[gRowBase + nextState] = psRow;
              }
              btRow[nextSp] = optIdx;
              psRow![nextSp] = prevState;
              if (nextSp > maxReachedSp) {
                maxReachedSp = nextSp;
              }
            }
          }

          nextStateMaxSp[nextState] = maxReachedSp;
        }
      }

      const tmpDp = stateDp;
      stateDp = nextStateDp;
      nextStateDp = tmpDp;

      const tmpMaxSp = stateMaxSp;
      stateMaxSp = nextStateMaxSp;
      nextStateMaxSp = tmpMaxSp;
    }

    // 到達可能な state ごとにパレート最適 (sp 昇順, score 狭義単調増加) 点を抽出
    interface ReachableStateEntry {
      state: number;
      sc: number;
      counts: number[];
      pareto: Array<{ sp: number; score: number }>;
    }
    const reachableStates: ReachableStateEntry[] = [];
    for (let state = 0; state < numStates; state++) {
      const reached = stateMaxSp[state];
      if (reached < 0) continue;
      const sc = Math.floor(state / scStride);
      const counts = new Array<number>(numCondDims);
      let rem = state - sc * scStride;
      for (let j = 0; j < numCondDims; j++) {
        const cStride = condStrides[j];
        counts[j] = Math.floor(rem / cStride);
        rem -= counts[j] * cStride;
      }

      const offset = state * stateStride;
      const pareto: Array<{ sp: number; score: number }> = [];
      let bestScoreInState = -1;
      for (let sp = 0; sp <= reached; sp++) {
        const score = stateDp[offset + sp];
        if (score > bestScoreInState) {
          bestScoreInState = score;
          pareto.push({ sp, score });
        }
      }
      if (pareto.length > 0) {
        reachableStates.push({ state, sc, counts, pareto });
      }
    }

    // 4c. condEvoGroups の選択肢整理と第2段階 DFS 結合
    interface CondChoice {
      optIdx: number;
      cost: number;
      score: number;
      needSc: number;
      deltaC: number[];
      reqC: number[];
    }
    const condGroupChoices: CondChoice[][] = [];
    for (const group of condEvoGroups) {
      const choicesByKey = new Map<string, CondChoice>();
      if (group.canSkip) {
        choicesByKey.set('skip', {
          optIdx: -1,
          cost: 0,
          score: 0,
          needSc: 0,
          deltaC: new Array<number>(numCondDims).fill(0),
          reqC: new Array<number>(numCondDims).fill(0),
        });
      }
      for (let optIdx = 0; optIdx < group.options.length; optIdx++) {
        const opt = group.options[optIdx];
        if (opt.dpCost > maxSp || opt.needSc > maxScen) continue;
        const deltaC = activeMasks.map((m) => ((opt.optNewMask & m) !== 0 ? 1 : 0));
        const reqC = new Array<number>(numCondDims).fill(0);
        if (opt.reqConditions) {
          for (const req of opt.reqConditions) {
            const dimIdx = activeMasks.indexOf(req.mask);
            if (dimIdx >= 0 && req.requiredNewCount > reqC[dimIdx]) {
              reqC[dimIdx] = req.requiredNewCount;
            }
          }
        }
        const key = `${opt.dpCost}:${opt.needSc}:${deltaC.join(',')}:${reqC.join(',')}`;
        const prev = choicesByKey.get(key);
        if (!prev || opt.scoreValue > prev.score) {
          choicesByKey.set(key, {
            optIdx,
            cost: opt.dpCost,
            score: opt.scoreValue,
            needSc: opt.needSc,
            deltaC,
            reqC,
          });
        }
      }
      condGroupChoices.push(Array.from(choicesByKey.values()));
    }

    const suffixMaxDeltaC: number[][] = Array.from(
      { length: condEvoGroups.length + 1 },
      () => new Array<number>(numCondDims).fill(0)
    );
    for (let k = condEvoGroups.length - 1; k >= 0; k--) {
      for (let j = 0; j < numCondDims; j++) {
        let maxAdd = 0;
        for (const ch of condGroupChoices[k]) {
          if (ch.deltaC[j] > maxAdd) maxAdd = ch.deltaC[j];
        }
        suffixMaxDeltaC[k][j] = suffixMaxDeltaC[k + 1][j] + maxAdd;
      }
    }

    let bestTotalScore = -1;
    let bestTotalSp = 0;
    let bestPureSp = 0;
    let bestState = 0;
    let bestStateSp = 0;
    let bestCondTuple: number[] = [];

    const curTuple = new Array<number>(condEvoGroups.length).fill(-1);
    const curDeltaC = new Array<number>(numCondDims).fill(0);
    const curReqC = new Array<number>(numCondDims).fill(0);

    const evaluateLeaf = (curDeltaSp: number, curDeltaSc: number, curDeltaScore: number): void => {
      const remAfterCond = maxSp - curDeltaSp;
      for (const rs of reachableStates) {
        if (rs.sc + curDeltaSc > maxScen) continue;
        let condOk = true;
        for (let j = 0; j < numCondDims; j++) {
          if (rs.counts[j] + curDeltaC[j] < curReqC[j]) {
            condOk = false;
            break;
          }
        }
        if (!condOk) continue;

        for (const pt of rs.pareto) {
          if (pt.sp > remAfterCond) break;
          const remForPure = Math.min(pureMaxSp, remAfterCond - pt.sp);
          const pureScore = prefixBestPureScore[remForPure];
          if (pureScore < 0) continue;
          const pureSp = prefixBestPureSp[remForPure];
          const totalScore = pureScore + pt.score + curDeltaScore;
          const totalSp = pureSp + pt.sp + curDeltaSp;
          if (
            totalScore > bestTotalScore ||
            (totalScore === bestTotalScore && totalSp < bestTotalSp)
          ) {
            bestTotalScore = totalScore;
            bestTotalSp = totalSp;
            bestPureSp = pureSp;
            bestState = rs.state;
            bestStateSp = pt.sp;
            bestCondTuple = curTuple.slice();
          }
        }
      }
    };

    const dfsCond = (
      idx: number,
      curSp: number,
      curSc: number,
      curScore: number
    ): void => {
      if (idx === condEvoGroups.length) {
        evaluateLeaf(curSp, curSc, curScore);
        return;
      }

      for (const ch of condGroupChoices[idx]) {
        const nextSp = curSp + ch.cost;
        if (nextSp > maxSp) continue;
        const nextSc = curSc + ch.needSc;
        if (nextSc > maxScen) continue;

        let feasible = true;
        const prevReqC = curReqC.slice();
        for (let j = 0; j < numCondDims; j++) {
          curDeltaC[j] += ch.deltaC[j];
          if (ch.reqC[j] > curReqC[j]) curReqC[j] = ch.reqC[j];
          if (stateDimCaps[j] + curDeltaC[j] + suffixMaxDeltaC[idx + 1][j] < curReqC[j]) {
            feasible = false;
          }
        }

        if (feasible) {
          curTuple[idx] = ch.optIdx;
          dfsCond(idx + 1, nextSp, nextSc, curScore + ch.score);
        }

        for (let j = 0; j < numCondDims; j++) {
          curDeltaC[j] -= ch.deltaC[j];
          curReqC[j] = prevReqC[j];
        }
      }
    };

    dfsCond(0, 0, 0, 0);

    if (bestTotalScore < 0) {
      return { finalRecommended, dpEvolutionAssignments, acquiredEvolutionBonus };
    }

    const recordChosenOption = (group: DpGroup, chosen: DpOption): void => {
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
    };

    // 4d. pureNormalGroups のバックトラック
    let currPureSp = bestPureSp;
    for (let g = pureNormalGroups.length - 1; g >= 0; g--) {
      const optIdx = pureBacktrack[g * pureStride + currPureSp];
      if (optIdx >= 0) {
        const group = pureNormalGroups[g];
        const chosen = group.options[optIdx];
        recordChosenOption(group, chosen);
        currPureSp -= chosen.dpCost;
      }
    }

    // 4e. stateChangingNormalGroups のバックトラック
    let currState = bestState;
    let currStateSp = bestStateSp;
    for (let g = stateChangingNormalGroups.length - 1; g >= 0; g--) {
      const rowIdx = g * numStates + currState;
      const optIdx = backtrackRows[rowIdx]?.[currStateSp] ?? -1;
      if (optIdx >= 0) {
        const group = stateChangingNormalGroups[g];
        const chosen = group.options[optIdx];
        recordChosenOption(group, chosen);
        const prevState = prevStateRows[rowIdx]![currStateSp];
        currStateSp -= chosen.dpCost;
        currState = prevState;
      }
    }

    // 4f. condEvoGroups の選択結果を反映
    for (let k = 0; k < condEvoGroups.length; k++) {
      const optIdx = bestCondTuple[k];
      if (optIdx >= 0) {
        const group = condEvoGroups[k];
        recordChosenOption(group, group.options[optIdx]);
      }
    }

    return { finalRecommended, dpEvolutionAssignments, acquiredEvolutionBonus };
  }

  private resolveEvoItemConditions(
    requiredSkillConditions: SkillConditionRequirement[][] | undefined,
    hasBadge: boolean,
    hasNormalWhiteSkillsInInput: boolean,
    selfGroupId: number,
    selfNewMask: number,
    countBaseOwned: (mask: number) => number,
    maxOtherNewAvailable: (mask: number, excludeGroupId: number) => number
  ): ReqCondition[][] | null {
    if (
      hasBadge ||
      !hasNormalWhiteSkillsInInput ||
      !requiredSkillConditions ||
      requiredSkillConditions.length === 0
    ) {
      return [[]];
    }

    const activeAndGroups: ReqCondition[][] = [];
    for (const orList of requiredSkillConditions) {
      let alreadySatisfied = false;
      const reachableOrs: ReqCondition[] = [];

      for (const req of orList) {
        const needed = Math.max(0, req.count - countBaseOwned(req.mask));
        if (needed === 0) {
          alreadySatisfied = true;
          break;
        }
        const selfSupply = (selfNewMask & req.mask) !== 0 ? 1 : 0;
        const maxSupply = selfSupply + maxOtherNewAvailable(req.mask, selfGroupId);
        if (maxSupply >= needed) {
          reachableOrs.push({ mask: req.mask, requiredNewCount: needed });
        }
      }

      if (alreadySatisfied) continue;
      if (reachableOrs.length === 0) return null;
      activeAndGroups.push(reachableOrs);
    }

    if (activeAndGroups.length === 0) {
      return [[]];
    }

    let combos: Map<number, number>[] = [new Map()];
    for (const orOpts of activeAndGroups) {
      const nextCombos: Map<number, number>[] = [];
      for (const prev of combos) {
        for (const opt of orOpts) {
          const merged = new Map(prev);
          const existing = merged.get(opt.mask) ?? 0;
          if (opt.requiredNewCount > existing) {
            merged.set(opt.mask, opt.requiredNewCount);
          }
          nextCombos.push(merged);
        }
      }
      combos = nextCombos;
    }

    const seenKeys = new Set<string>();
    const results: ReqCondition[][] = [];
    for (const map of combos) {
      const entries = Array.from(map.entries())
        .filter(([, cnt]) => cnt > 0)
        .sort((a, b) => a[0] - b[0]);
      const key = entries.map(([m, c]) => `${m}:${c}`).join('|');
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      results.push(entries.map(([mask, requiredNewCount]) => ({ mask, requiredNewCount })));
    }
    return results;
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
    maxAwakeningRank: number,
    maxScen: number,
    aptitudes: AptitudeState,
    isSkillTest: boolean,
    hasBadge: boolean,
    hasNormalWhiteSkillsInInput: boolean,
    selfGroupId: number,
    selfNewMask: number,
    countBaseOwned: (mask: number) => number,
    maxOtherNewAvailable: (mask: number, excludeGroupId: number) => number
  ): EvoOptionDetail[] {
    const details: EvoOptionDetail[] = [];
    const bonusDelta = isSkillTest ? SKILL_TEST_BONUS.evolved - SKILL_TEST_BONUS.rare : 0;

    const collectForSlot = (
      slotType: 'chara_lv3' | 'chara_lv5' | 'chara_lv7' | 'scenario',
      items: Array<{ evolvedSkillId: number; requiredSkillConditions?: SkillConditionRequirement[][] }>
    ): void => {
      let bestUncond: EvoOptionDetail | undefined;
      const condByKey = new Map<string, EvoOptionDetail>();

      for (const evoItem of items) {
        const evolvedSkill = this.masterStore.skillsById.get(evoItem.evolvedSkillId);
        if (!evolvedSkill) continue;

        const evoEff = calculateEffectiveGradeValue(
          evolvedSkill.gradeValue,
          evolvedSkill.distanceTypes,
          evolvedSkill.runningStyles,
          aptitudes
        );
        const gain = evoEff - goldEff;
        if (gain + bonusDelta <= 0) continue;

        const combos = this.resolveEvoItemConditions(
          evoItem.requiredSkillConditions,
          hasBadge,
          hasNormalWhiteSkillsInInput,
          selfGroupId,
          selfNewMask,
          countBaseOwned,
          maxOtherNewAvailable
        );
        if (!combos) continue;

        for (const reqList of combos) {
          if (reqList.length === 0) {
            if (!bestUncond || gain > bestUncond.evoDelta) {
              bestUncond = {
                slotType,
                evolvedSkill,
                evoEff,
                baseEff: goldEff,
                evoDelta: gain,
              };
            }
          } else {
            const key = reqList.map((r) => `${r.mask}:${r.requiredNewCount}`).join('|');
            const prev = condByKey.get(key);
            if (!prev || gain > prev.evoDelta) {
              condByKey.set(key, {
                slotType,
                evolvedSkill,
                evoEff,
                baseEff: goldEff,
                evoDelta: gain,
                reqConditions: reqList,
              });
            }
          }
        }
      }

      if (bestUncond) {
        details.push(bestUncond);
      }
      for (const condDetail of condByKey.values()) {
        if (!bestUncond || condDetail.evoDelta > bestUncond.evoDelta) {
          details.push(condDetail);
        }
      }
    };

    if (cardId) {
      const charaEvos = this.masterStore.charaEvolutionsByCardId.get(cardId) || [];
      for (const rank of [3, 5, 7] as const) {
        if (rank > maxAwakeningRank) continue;
        const evosForRank = charaEvos.filter((e) => e.slotRank === rank && e.baseSkillId === skillId);
        if (evosForRank.length === 0) continue;
        const slotType = rank === 3 ? 'chara_lv3' : rank === 5 ? 'chara_lv5' : 'chara_lv7';
        collectForSlot(slotType, evosForRank);
      }
    }

    if (scenarioId && maxScen > 0) {
      const scEvos = this.masterStore.scenarioEvolutionsByScenarioId.get(scenarioId) || [];
      const matchingScEvos = scEvos.filter((e) => e.baseSkillId === skillId);
      if (matchingScEvos.length > 0) {
        collectForSlot('scenario', matchingScEvos);
      }
    }

    return details;
  }

  /**
   * DP で最適割当された自前進化（覚醒Lv3, Lv5, Lv7）、シナリオ進化、および継承進化の推奨ガイドを生成
   */
  private generateEvolutionRecommendations(
    acquiredOrRecommendedIds: Set<number>,
    dpEvolutionAssignments: Map<number, DpEvolutionAssignment>,
    cardId: number | undefined,
    scenarioId: number | undefined,
    maxAwakeningRank: number,
    maxScen: number,
    aptitudes: AptitudeState
  ): EvolutionRecommendation[] {
    const results: EvolutionRecommendation[] = [];

    // 1. 自前進化 (覚醒Lv3, Lv5, Lv7)
    if (cardId) {
      const charaEvos = this.masterStore.charaEvolutionsByCardId.get(cardId) || [];

      for (const rank of [3, 5, 7] as const) {
        if (rank > maxAwakeningRank) continue;
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
        const slotType = rank === 3 ? 'chara_lv3' : rank === 5 ? 'chara_lv5' : 'chara_lv7';
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
          recommendationNote =
            best && best.gain > 0
              ? '進化条件（スキル所持数）未達成'
              : best
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
