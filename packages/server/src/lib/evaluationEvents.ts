/**
 * Eval run lifecycle webhooks (the evaluations module doc).
 *
 * This event plus the verdict it carries **is** the promotion gate consumed by
 * the agents module's eval-gated promotion: a deploy pipeline subscribes, reads
 * `passed`, and promotes or aborts. That is why the payload is the run record,
 * verdict and aggregates included, rather than only an id to fetch — a gate
 * that has to make a second call to learn its answer is a gate that can fail
 * open when the second call does.
 */
import createDebug from 'debug';

import { mapEvalRun, reloadEvalRun } from './evaluationRunReads';
import { emitLoadedRecordEvent } from './recordEvents';

const log = createDebug('soat:evaluations');

/** A run reached a terminal status with its items scored. */
export const EVAL_RUN_COMPLETED_EVENT = 'eval_run.completed';

/** A run could not be executed to completion (infrastructure failure). */
export const EVAL_RUN_FAILED_EVENT = 'eval_run.failed';

/**
 * Fires one eval run lifecycle event, carrying the run as `GET` answers it.
 *
 * Best-effort by construction: `emitLoadedRecordEvent` never throws, so a
 * subscriber being down — or a transient DB blip in the read — never changes
 * the run's recorded outcome. Called from the single finalize path, which both
 * the synchronous and the queued run funnel through, so a run cannot fire
 * twice or (worse, for a gate) not at all.
 */
export const emitEvalRunEvent = async (args: {
  event: typeof EVAL_RUN_COMPLETED_EVENT | typeof EVAL_RUN_FAILED_EVENT;
  projectId: number;
  run: { id?: unknown; publicId: string };
}): Promise<void> => {
  log('emitEvalRunEvent: event=%s run=%s', args.event, args.run.publicId);

  await emitLoadedRecordEvent({
    type: args.event,
    projectId: args.projectId,
    resourceType: 'eval_run',
    resourceId: args.run.publicId,
    load: async () => {
      return mapEvalRun(await reloadEvalRun(args.run));
    },
  });
};
