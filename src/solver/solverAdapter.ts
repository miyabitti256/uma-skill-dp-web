import type { ISkillSolver } from './solverInterface.ts';
import { TypeScriptSkillSolver } from './skillSolver.ts';
import type { SolverOptions, SolverResult } from '../types/solver.ts';
import type { DetectedSkillItem } from '../types/recognition.ts';
import { MasterStore } from '../data/masterStore.ts';

export class SkillSolverAdapter implements ISkillSolver {
  private solver: TypeScriptSkillSolver;

  constructor(masterStore?: MasterStore) {
    this.solver = new TypeScriptSkillSolver(masterStore);
  }

  public async solve(
    skills: DetectedSkillItem[],
    options: SolverOptions
  ): Promise<SolverResult> {
    return this.solver.solve(skills, options);
  }
}
