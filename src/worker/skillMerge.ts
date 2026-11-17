import type { DetectedSkillItem } from '../types/recognition.ts';

/**
 * Worker からの認識済みスキル配列を既存の UI 状態（ロック・除外・より新しい更新）を保ちつつマージする。
 */
export function mergeRecognizedSkills(
  prev: DetectedSkillItem[],
  incomingSkills: DetectedSkillItem[]
): DetectedSkillItem[] {
  const prevMap = new Map<number, DetectedSkillItem>();
  for (const p of prev) {
    prevMap.set(p.id, p);
  }

  let hasChanged = prev.length !== incomingSkills.length;
  const nextList: DetectedSkillItem[] = [];

  for (const s of incomingSkills) {
    const existing = prevMap.get(s.id);
    if (existing) {
      const isRefreshed = s.lastSeenTimestamp >= existing.lastSeenTimestamp;
      const nextState = isRefreshed ? s.state : existing.state;
      const nextCost = isRefreshed ? s.recognizedCost : existing.recognizedCost;
      const nextTs = isRefreshed ? s.lastSeenTimestamp : existing.lastSeenTimestamp;

      if (nextState !== existing.state || nextCost !== existing.recognizedCost) {
        hasChanged = true;
      }
      if (
        nextState === existing.state &&
        nextCost === existing.recognizedCost &&
        nextTs === existing.lastSeenTimestamp
      ) {
        nextList.push(existing);
      } else {
        nextList.push({
          ...existing,
          state: nextState,
          recognizedCost: nextCost,
          lastSeenTimestamp: nextTs,
        });
      }
    } else {
      hasChanged = true;
      nextList.push(s);
    }
  }

  return hasChanged ? nextList : prev;
}
