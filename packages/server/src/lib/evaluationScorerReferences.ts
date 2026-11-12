import { validateDeciderScorerRefs } from './evaluationDeciderScorer';
import { DECIDER_SCORER_TYPE } from './evaluationDeciderScorerContract';
import { validateToolScorerRefs } from './evaluationToolScorer';
import { assertJudgeScorersResolvable } from './modelRouteDefaults';
import { isPlainObject } from './plainObject';
import { type CarriedAction, startOf } from './writerRule';

/**
 * The checks on an eval's scorers that read the database, run at every gate
 * that validates their shape: eval create, eval update, and run start. A tool
 * scorer's tool must be one a run can invoke, a decider scorer's decider must
 * exist in the project; an `llm_judge` that pins no
 * provider needs a project default to inherit.
 */
export const validateScorerReferences = async (args: {
  scorers: unknown;
  projectId: number;
}): Promise<void> => {
  await validateToolScorerRefs(args);
  await validateDeciderScorerRefs(args);
  await assertJudgeScorersResolvable(args);
};

/** What every run of the eval starts: its agent, each tool and decider scorer. */
export const evalStarts = (args: {
  agentId: string;
  scorers: unknown;
}): CarriedAction[] => {
  const scorers = Array.isArray(args.scorers) ? args.scorers : [];
  return [
    startOf({ type: 'agent', id: args.agentId }),
    ...scorers.flatMap((scorer): CarriedAction[] => {
      if (!isPlainObject(scorer)) return [];
      if (scorer.type === 'tool') {
        return [startOf({ type: 'tool', id: String(scorer.tool_id) })];
      }
      if (scorer.type === DECIDER_SCORER_TYPE) {
        return [startOf({ type: 'decider', id: String(scorer.decider_id) })];
      }
      return [];
    }),
  ];
};
