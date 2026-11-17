import { MasterStore } from '../data/masterStore.ts';
import type {
  AptitudeRank,
  AptitudeState,
  DetectedSkillItem,
  ScreenMode,
  SkillState,
} from '../types/recognition.ts';
import type { RecognitionOutput } from './imageRecognizer.ts';

interface AggregatedFrameResult {
  screenMode: ScreenMode;
  detectedSkillPoint?: number;
  detectedAptitudes?: Partial<AptitudeState>;
  detectedCardId?: number;
  detectedSkills: DetectedSkillItem[];
}

/**
 * 並列認識ワーカーからのフレーム出力を時系列順に集約し、
 * スキル蓄積・○◎連動・SP/適性2フレーム合意を一貫管理する。
 */
export class RecognitionAggregator {
  private masterStore: MasterStore;
  private accumulatedSkills = new Map<number, DetectedSkillItem>();
  private nextRecognitionOrder = 1;
  private frameCount = 0;

  private lastValidAptitudes: Partial<AptitudeState> | undefined = undefined;
  private candidateAptitudes: Partial<AptitudeState> | undefined = undefined;
  private lastValidCardId: number | undefined = undefined;

  private lastConfirmedSkillPoint: number | undefined = undefined;
  private candidateSkillPoint: { val: number; count: number; lastFrame: number } | undefined =
    undefined;

  private cachedSkillsArray: DetectedSkillItem[] = [];
  private skillsDirty = true;
  private skillMeta = new Map<
    number,
    {
      synthetic: boolean;
      stateCandidate?: { val: SkillState; count: number; lastFrame: number };
    }
  >();

  constructor(masterStore: MasterStore) {
    this.masterStore = masterStore;
  }

  public reset(): void {
    this.accumulatedSkills.clear();
    this.skillMeta.clear();
    this.cachedSkillsArray = [];
    this.skillsDirty = true;
    this.lastValidCardId = undefined;
    this.lastValidAptitudes = undefined;
    this.candidateAptitudes = undefined;
    this.lastConfirmedSkillPoint = undefined;
    this.candidateSkillPoint = undefined;
    this.nextRecognitionOrder = 1;
    this.frameCount = 0;
  }

  private resolveSkillState(
    skillId: number,
    rawState: SkillState,
    existing: DetectedSkillItem | undefined,
    isStaticImage: boolean
  ): SkillState {
    if (!existing || isStaticImage || rawState === existing.state) {
      const meta = this.skillMeta.get(skillId);
      if (meta) meta.stateCandidate = undefined;
      return rawState;
    }

    const meta = this.skillMeta.get(skillId) ?? { synthetic: false };
    const cand = meta.stateCandidate;
    if (cand && cand.val === rawState && this.frameCount - cand.lastFrame <= 6) {
      cand.count++;
      cand.lastFrame = this.frameCount;
      if (cand.count >= 2) {
        meta.stateCandidate = undefined;
        this.skillMeta.set(skillId, meta);
        return rawState;
      }
      this.skillMeta.set(skillId, meta);
      return existing.state;
    }

    meta.stateCandidate = { val: rawState, count: 1, lastFrame: this.frameCount };
    this.skillMeta.set(skillId, meta);
    return existing.state;
  }

  private unlockGoldCostsInGroup(groupId: number): void {
    for (const [id, skill] of this.accumulatedSkills) {
      if (skill.groupId === groupId && skill.rarity === 2) {
        this.skillMeta.set(id, { ...this.skillMeta.get(id), synthetic: true });
      }
    }
  }

  public processOutput(
    output: RecognitionOutput,
    isStaticImage = false
  ): AggregatedFrameResult {
    this.frameCount++;
    const screenMode: ScreenMode = output.screenMode;

    // 適性変換（2フレーム連続安定一致で確定更新し、閉鎖時の遷移ノイズによる誤上書きを防止）
    let detectedAptitudes: Partial<AptitudeState> | undefined = undefined;
    if (output.aptitudes && output.screenType === 'ウマ娘詳細適性ポップアップ') {
      const currentApt: Partial<AptitudeState> = {
        turf: (output.aptitudes['芝'] as AptitudeRank) || 'A',
        dirt: (output.aptitudes['ダート'] as AptitudeRank) || 'G',
        short: (output.aptitudes['短距離'] as AptitudeRank) || 'A',
        mile: (output.aptitudes['マイル'] as AptitudeRank) || 'A',
        middle: (output.aptitudes['中距離'] as AptitudeRank) || 'A',
        long: (output.aptitudes['長距離'] as AptitudeRank) || 'A',
        nige: (output.aptitudes['逃げ'] as AptitudeRank) || 'A',
        senkou: (output.aptitudes['先行'] as AptitudeRank) || 'A',
        sashi: (output.aptitudes['差し'] as AptitudeRank) || 'A',
        oikomi: (output.aptitudes['追込'] as AptitudeRank) || 'A',
      };

      const isMatch =
        this.candidateAptitudes &&
        Object.keys(currentApt).every(
          (k) =>
            currentApt[k as keyof AptitudeState] ===
            this.candidateAptitudes![k as keyof AptitudeState]
        );

      if (!this.lastValidAptitudes || isMatch) {
        this.lastValidAptitudes = currentApt;
        detectedAptitudes = currentApt;
      } else {
        detectedAptitudes = this.lastValidAptitudes;
      }
      this.candidateAptitudes = currentApt;
    } else {
      this.candidateAptitudes = undefined;
      if (this.lastValidAptitudes) {
        detectedAptitudes = this.lastValidAptitudes;
      }
    }

    if (output.detectedCardId && output.screenType === 'ウマ娘詳細適性ポップアップ') {
      this.lastValidCardId = output.detectedCardId;
    }

    const isSkillPointValid = output.skillPointValid ?? output.skillPoint > 0;
    if (isStaticImage) {
      if (isSkillPointValid) {
        this.lastConfirmedSkillPoint = output.skillPoint;
      }
    } else {
      if (isSkillPointValid) {
        if (
          this.candidateSkillPoint &&
          this.candidateSkillPoint.val === output.skillPoint &&
          this.frameCount - this.candidateSkillPoint.lastFrame <= 3
        ) {
          this.candidateSkillPoint.count++;
          this.candidateSkillPoint.lastFrame = this.frameCount;
          if (this.candidateSkillPoint.count >= 2) {
            this.lastConfirmedSkillPoint = output.skillPoint;
          }
        } else {
          this.candidateSkillPoint = {
            val: output.skillPoint,
            count: 1,
            lastFrame: this.frameCount,
          };
        }
      }
    }
    const detectedSkillPoint = this.lastConfirmedSkillPoint;

    // 認識されたカード情報をマスタデータと結合して蓄積
    if (output.cards.length > 0) {
      for (const card of output.cards) {
        // Why not 2-frame consensus: ImageRecognizer already enforces height/cutoff/ink-density/worst-char/XOR/validCosts gates
        // with 0 Frame FP, whereas requiring 2 frames drops cards during normal drag-scroll (~118 skills in ~10.7s).
        const master = this.masterStore.skillsById.get(card.skillId);
        const rarity = master ? master.rarity : 1;

        // 本体固有スキルと継承固有スキルの混入・二重登録防止
        const isInheritableUnique = card.skillId >= 900000 && card.skillId < 1000000;
        if (isInheritableUnique) {
          const activeCard = this.lastValidCardId
            ? this.masterStore.cardsById.get(this.lastValidCardId)
            : undefined;
          const activeUniqueSkill = activeCard
            ? this.masterStore.skillsById.get(activeCard.uniqueSkillId)
            : undefined;
          if (activeUniqueSkill && activeUniqueSkill.name === card.name) {
            continue;
          }
          let hasInnateDuplicate = false;
          for (const acc of this.accumulatedSkills.values()) {
            if (acc.rarity >= 3 && acc.name === card.name) {
              hasInnateDuplicate = true;
              break;
            }
          }
          if (hasInnateDuplicate) {
            continue;
          }
        } else if (rarity >= 3) {
          for (const [accId, acc] of this.accumulatedSkills.entries()) {
            if (accId >= 900000 && accId < 1000000 && acc.name === card.name) {
              this.accumulatedSkills.delete(accId);
              this.skillMeta.delete(accId);
              this.skillsDirty = true;
            }
          }
        }

        const existing = this.accumulatedSkills.get(card.skillId);
        const existingMeta = this.skillMeta.get(card.skillId);

        const baseCost = master ? master.needSkillPoint : card.needSp;
        const gradeValue = master ? master.gradeValue : 0;
        const groupId = master ? master.groupId : card.skillId;
        const groupRate = master ? master.groupRate : 1;

        // 固有スキル（最初から獲得済み）の強制獲得済化
        let rawState = card.state;
        const isUniqueSkill = master && (master.rarity >= 3 || master.needSkillPoint === 0);
        if (isUniqueSkill && card.needSp === 0) {
          rawState = 'acquired';
        }
        const cardState = this.resolveSkillState(card.skillId, rawState, existing, isStaticImage);

        if (existing && existing.state !== cardState) {
          this.unlockGoldCostsInGroup(groupId);
        }

        // 全レアリティで確定コストをロック（直接未観測の合成◎およびシブリング状態変化時のみ更新許可）
        const isSynthetic = existingMeta?.synthetic ?? false;
        let recognizedCost: number;
        if (existing && !isSynthetic && (existing.recognizedCost > 0 || card.needSp === 0)) {
          recognizedCost = existing.recognizedCost;
        } else {
          recognizedCost = card.needSp > 0 ? card.needSp : existing ? existing.recognizedCost : baseCost;
        }

        // ○ と ◎ の連動認識 & 自動同期 (◎を削除せず常に共存・同期)
        if (rarity === 1 && (groupRate === 1 || groupRate === 2)) {
          const groupList = this.masterStore.skillsByGroupId.get(groupId);
          const circleSkill = groupList?.find((s) => s.groupRate === 1 && s.rarity === 1);
          const doubleSkill = groupList?.find((s) => s.groupRate === 2 && s.rarity === 1);

          if (circleSkill && doubleSkill) {
            if (groupRate === 1) {
              const discountRatio =
                circleSkill.needSkillPoint > 0 && cardState === 'unselected' && recognizedCost > 0
                  ? recognizedCost / circleSkill.needSkillPoint
                  : 1.0;
              const doubleCost = Math.round(doubleSkill.needSkillPoint * discountRatio);

              if (!this.accumulatedSkills.has(doubleSkill.id)) {
                this.accumulatedSkills.set(doubleSkill.id, {
                  id: doubleSkill.id,
                  name: doubleSkill.name,
                  recognizedCost: doubleCost,
                  baseCost: doubleSkill.needSkillPoint,
                  gradeValue: doubleSkill.gradeValue,
                  rarity: doubleSkill.rarity,
                  groupId: doubleSkill.groupId,
                  groupRate: doubleSkill.groupRate,
                  state: 'unselected',
                  isLocked: false,
                  isExcluded: false,
                  canEvolve: false,
                  lastSeenTimestamp: Date.now(),
                  firstSeenOrder: this.nextRecognitionOrder++,
                });
                this.skillMeta.set(doubleSkill.id, { synthetic: true });
                this.skillsDirty = true;
              } else {
                const existingDouble = this.accumulatedSkills.get(doubleSkill.id)!;
                const doubleMeta = this.skillMeta.get(doubleSkill.id);
                if (
                  doubleMeta?.synthetic &&
                  cardState === 'unselected' &&
                  existingDouble.state === 'unselected' &&
                  existingDouble.recognizedCost !== doubleCost
                ) {
                  existingDouble.recognizedCost = doubleCost;
                  existingDouble.lastSeenTimestamp = Date.now();
                  this.skillsDirty = true;
                }
              }
            } else if (groupRate === 2) {
              const existingCircle = this.accumulatedSkills.get(circleSkill.id);
              if (existingCircle) {
                if (existingCircle.state === 'unselected') {
                  existingCircle.state = 'selected';
                  existingCircle.lastSeenTimestamp = Date.now();
                  this.skillsDirty = true;
                }
              } else {
                const discountRatio =
                  doubleSkill.needSkillPoint > 0 && recognizedCost > 0 && cardState === 'unselected'
                    ? recognizedCost / doubleSkill.needSkillPoint
                    : 1.0;
                const circleCost = Math.round(circleSkill.needSkillPoint * discountRatio);
                this.accumulatedSkills.set(circleSkill.id, {
                  id: circleSkill.id,
                  name: circleSkill.name,
                  recognizedCost: circleCost,
                  baseCost: circleSkill.needSkillPoint,
                  gradeValue: circleSkill.gradeValue,
                  rarity: circleSkill.rarity,
                  groupId: circleSkill.groupId,
                  groupRate: circleSkill.groupRate,
                  state: 'selected',
                  isLocked: false,
                  isExcluded: false,
                  canEvolve: false,
                  lastSeenTimestamp: Date.now(),
                  firstSeenOrder: this.nextRecognitionOrder++,
                });
                this.skillMeta.set(circleSkill.id, { synthetic: true });
                this.skillsDirty = true;
              }
            }
          }
        }

        const canEvolve = false;
        const nextMeta = existingMeta ? { ...existingMeta, synthetic: false } : { synthetic: false };
        this.skillMeta.set(card.skillId, nextMeta);

        if (
          !existing ||
          existing.state !== cardState ||
          existing.recognizedCost !== recognizedCost ||
          existing.canEvolve !== canEvolve
        ) {
          this.skillsDirty = true;
          this.accumulatedSkills.set(card.skillId, {
            id: card.skillId,
            name: card.name,
            recognizedCost,
            baseCost,
            gradeValue,
            rarity,
            groupId,
            groupRate,
            state: cardState,
            isLocked: existing ? existing.isLocked : false,
            isExcluded: existing ? existing.isExcluded : false,
            canEvolve,
            lastSeenTimestamp: Date.now(),
            firstSeenOrder: existing ? existing.firstSeenOrder : this.nextRecognitionOrder++,
          });
        }
      }
    }

    if (this.skillsDirty || this.cachedSkillsArray.length === 0) {
      this.cachedSkillsArray = Array.from(this.accumulatedSkills.values());
      this.skillsDirty = false;
    }

    return {
      screenMode,
      detectedSkillPoint,
      detectedAptitudes,
      detectedCardId: output.detectedCardId || this.lastValidCardId,
      detectedSkills: this.cachedSkillsArray,
    };
  }
}
