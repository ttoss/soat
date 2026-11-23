/**
 * The checks an Eval write runs on what it leaves standing: its scorers,
 * named and runnable against the agent, and its criteria, binding every one
 * of those scorers.
 */
import { validateCriteria } from './evaluationCriteria';
import { validateScorerReferences } from './evaluationScorerReferences';
import { validateScorers } from './evaluationScorers';
import { assertValid } from './evaluationValidation';
import { isPlainObject } from './plainObject';

type StoredEval = { scorers: unknown; criteria: unknown };

/**
 * The scorers an Eval write leaves, validated: the ones written, each named,
 * or, when the write names none, the ones stored, re-checked against a new
 * agent. Returns the scorers that stand.
 */
export const assertScorers = async (args: {
  written: unknown;
  stored?: unknown;
  agentOutputSchema: unknown;
  projectId: number;
}): Promise<unknown> => {
  const scorers = args.written === undefined ? args.stored : args.written;
  assertValid(
    validateScorers({
      scorers,
      agentHasOutputSchema: isPlainObject(args.agentOutputSchema),
      // expand-contract: an agent swap re-checks scorers stored unnamed
      names: args.written === undefined ? 'stored' : 'required',
    })
  );
  await validateScorerReferences({ scorers, projectId: args.projectId });
  return scorers;
};

/**
 * Judges `criteria` as the update leaves the pair with the scorers: a scorer
 * edit that orphans a stored criterion is refused as surely as criteria that
 * name a missing scorer.
 */
export const applyCriteriaUpdate = (args: {
  evaluation: StoredEval;
  updates: Record<string, unknown>;
  criteria: unknown;
}): void => {
  if (args.criteria === undefined && args.updates.scorers === undefined) {
    return;
  }
  const criteria =
    args.criteria === undefined ? args.evaluation.criteria : args.criteria;
  const scorers = args.updates.scorers ?? args.evaluation.scorers;
  assertValid(validateCriteria({ criteria, scorers }));
  if (args.criteria !== undefined) args.updates.criteria = args.criteria;
};
