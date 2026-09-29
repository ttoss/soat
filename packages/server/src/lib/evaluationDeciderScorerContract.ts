/**
 * The pure half of the `decider` scorer (the evaluations module doc — Decider
 * scorers): its config rules and how a decision becomes a score. The decision
 * itself is I/O, injected as a {@link DeciderScorerRunner}; the run path binds
 * `runDeciderScorerCall` from `evaluationDeciderScorer.ts`.
 */
import { DomainError } from '../errors';
import type { ScorerOutcome } from './evaluationScorers';
import { isUnitInterval } from './evaluationToolScorerContract';
import { evaluateLogic } from './jsonLogicMapping';

export const DECIDER_SCORER_TYPE = 'decider';

/** A completed decision, as the scorer reads it. */
export type DeciderScorerDecision = {
  decisionId: string;
  answers: Record<string, unknown>;
};

/**
 * Requests one decision for an item. A rejection propagates out of scoring and
 * errors the item: a decider that cannot answer says nothing about the agent.
 */
export type DeciderScorerRunner = (args: {
  scorer: Record<string, unknown>;
  state: unknown;
}) => Promise<DeciderScorerDecision>;

/**
 * `pass_threshold` is required with no default, as on `llm_judge`: a score
 * read off a distribution says nothing about where "good enough" is.
 */
export const checkDeciderScorerConfig = (args: {
  scorer: Record<string, unknown>;
  path: string;
  isBuiltInTypeName: (name: string) => boolean;
}): string | null => {
  const { scorer, path } = args;
  if (typeof scorer.name !== 'string' || scorer.name.trim() === '') {
    return `${path}.name is required and must be a non-empty string.`;
  }
  if (args.isBuiltInTypeName(scorer.name)) {
    return `${path}.name must not be a built-in scorer type ('${scorer.name}'); pick a name of your own.`;
  }
  if (typeof scorer.decider_id !== 'string' || scorer.decider_id === '') {
    return `${path}.decider_id is required and must be a decider id.`;
  }
  if (scorer.score === undefined) {
    return `${path}.score is required: a JSON Logic expression over { answers } yielding 0–1.`;
  }
  if (!isUnitInterval(scorer.pass_threshold)) {
    return `${path}.pass_threshold is required and must be a number between 0 and 1.`;
  }
  return null;
};

/**
 * Builds the state from the item context, requests the decision, and reads the
 * score off its answers. A score outside 0–1 throws, which errors the item.
 */
export const scoreDeciderScorer = async (args: {
  scorer: Record<string, unknown>;
  context: Record<string, unknown>;
  runDecider: DeciderScorerRunner;
}): Promise<ScorerOutcome> => {
  const { scorer } = args;
  const name = String(scorer.name);
  const state =
    scorer.state === undefined
      ? args.context
      : evaluateLogic(scorer.state, args.context);

  const decision = await args.runDecider({ scorer, state });
  const score = evaluateLogic(scorer.score, { answers: decision.answers });

  if (typeof score !== 'number' || !isUnitInterval(score)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Decider scorer '${name}': score evaluated to ${JSON.stringify(score)} on decision ${decision.decisionId}, not a number between 0 and 1.`
    );
  }

  return {
    scorer: name,
    score,
    passed: score >= Number(scorer.pass_threshold),
    decision_id: decision.decisionId,
  };
};
