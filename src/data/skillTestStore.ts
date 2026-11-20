import type {
  SkillTestCourseDef,
  SkillTestDataFile,
  SkillTestEditionDef,
  SkillTestSolveConfig,
} from '../types/skillTest.ts';

/**
 * 技能試験（スキル試験）の課程定義ストア。
 * MasterStore と同じシングルトン + load/init スタイル。
 *
 * v1 はフリー課程のみを対象とするため、スキル名→ID解決・課程倍率・
 * ステータスボーナスは取り扱わない（設計書 §5.2）。
 */
export class SkillTestStore {
  private static instance: SkillTestStore | null = null;

  public data: SkillTestDataFile | null = null;

  constructor(data?: SkillTestDataFile) {
    if (data) {
      this.init(data);
    }
  }

  public static getInstance(): SkillTestStore {
    if (!SkillTestStore.instance) {
      SkillTestStore.instance = new SkillTestStore();
    }
    return SkillTestStore.instance;
  }

  public async load(url = '/data/skill_test_courses.json'): Promise<SkillTestDataFile> {
    // MasterStore と同じく、既にロード済みなら再取得しない
    if (this.data) return this.data;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load skill test courses: ${res.statusText}`);
    }
    const data: SkillTestDataFile = await res.json();
    this.init(data);
    return data;
  }

  public init(data: SkillTestDataFile): void {
    this.data = data;
  }

  public get editions(): SkillTestEditionDef[] {
    return this.data?.editions ?? [];
  }

  public getEdition(id: string): SkillTestEditionDef | undefined {
    return this.editions.find((e) => e.id === id);
  }

  public getCourse(editionId: string, courseId: string): SkillTestCourseDef | undefined {
    const edition = this.getEdition(editionId);
    if (!edition) return undefined;
    return edition.courses.find((c) => c.id === courseId);
  }

  /**
   * 課程の解決済み設定を返す（ソルバへ渡す値）。
   * フリー課程は課程倍率 1.0 固定・全スキーがボーナス対象なので bonusSkillIds は null。
   * 未ロード／課程が存在しない場合も例外は投げず、既定値へフォールバックする。
   */
  public getSolveConfig(editionId: string, courseId: string): SkillTestSolveConfig {
    const edition = this.getEdition(editionId);
    const course = edition ? this.getCourse(editionId, courseId) : undefined;

    // 未ロード（edition なし）／課程なし（course なし）は既定値で安全側に倒す
    if (!edition || !course) {
      return {
        courseMultiplier: 1.0,
        skillBonus: { normal: 400, rare: 1200, evolved: 1500 },
        bonusSkillIds: null,
      };
    }

    return {
      courseMultiplier: 1.0,
      skillBonus: edition.skillBonus,
      bonusSkillIds: null,
    };
  }
}
