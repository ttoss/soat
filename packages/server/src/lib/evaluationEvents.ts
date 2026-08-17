/**
 * Eval run lifecycle webhooks (the evaluations module doc).
 *
 * This event plus the verdict it carries **is** the promotion gate consumed by
 * the agents module's eval-gated promotion: a deploy pipeline subscribes, reads
 * `passed`, and promotes or aborts. That is why the payload carries the verdict
 * and the aggregates inline rather than only an id to fetch — a gate that has to
 * make a second call to learn its answer is a gate that can fail open when the
 * second call does.
 */
import createDebug from 'debug';

import type { AggregateScores } from './evaluationScorerAggregation';
import { emitResourceEvent } from './eventBus';

const log = createDebug('soat:evaluations');

/** A run reached a terminal status with its items scored. */
export const EVAL_RUN_COMPLETED_EVENT = 'eval_run.completed';

/** A run could not be executed to completion (infrastructure failure). */
export const EVAL_RUN_FAILED_EVENT = 'eval_run.failed';

/**
 * Fires one eval run lifecycle event.
 *
 * Best-effort by construction: `emitResourceEvent` dispatches fire-and-forget
 * and owns the project-lookup rejection handler (#903), so a subscriber being
 * down — or a transient DB blip in the lookup — never changes the run's recorded
 * outcome. Called from the single finalize path, which both the synchronous and
 * the queued run funnel through, so a run cannot fire twice or (worse, for a
 * gate) not at all.
 */
export const emitEvalRunEvent = (args: {
  event: typeof EVAL_RUN_COMPLETED_EVENT | typeof EVAL_RUN_FAILED_EVENT;
  projectId: number;
  evalPublicId: string;
  runPublicId: string;
  passed: boolean | null;
  aggregateScores: AggregateScores | null;
}): void => {
  log(
    'emitEvalRunEvent: event=%s run=%s passed=%s',
    args.event,
    args.runPublicId,
    args.passed
  );

  emitResourceEvent({
    type: args.event,
    projectId: args.projectId,
    resourceType: 'eval_run',
    resourceId: args.runPublicId,
    // snake_case data keys to match the documented webhook contract.
    data: {
      eval_id: args.evalPublicId,
      eval_run_id: args.runPublicId,
      passed: args.passed,
      aggregate_scores: args.aggregateScores,
    },
  });
};
