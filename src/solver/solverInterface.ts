import type { SolverOptions, SolverResult } from '../types/solver.ts';
import type { DetectedSkillItem } from '../types/recognition.ts';

export interface ISkillSolver {
  solve(skills: DetectedSkillItem[], options: SolverOptions): Promise<SolverResult> | SolverResult;
}
