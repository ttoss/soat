import { validateToolScorerRefs } from './evaluationToolScorer';
import { assertJudgeScorersResolvable } from './modelRouteDefaults';

/**
 * The checks on an eval's scorers that read the database, run at every gate
 * that validates their shape: eval create, eval update, and run start. A tool
 * scorer's tool must be one a run can invoke; an `llm_judge` that pins no
 * provider needs a project default to inherit.
 */
export const validateScorerReferences = async (args: {
  scorers: unknown;
  projectId: number;
}): Promise<void> => {
  await validateToolScorerRefs(args);
  await assertJudgeScorersResolvable(args);
};
