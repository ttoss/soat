import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { resumeScheduledRun } from './orchestrationEngine';

const log = createDebug('soat:orchestrations');

const DEFAULT_INTERVAL_MS = 5000;
const BATCH_LIMIT = 20;

// Guards against the same run being resumed twice within a single process if a
// tick fires again before an in-flight resumption finishes.
const inFlight = new Set<number>();

/**
 * Finds runs whose scheduled resumption is due (`status = 'running'` and
 * `resumeAt <= now`), atomically claims each one, and resumes it. Because the
 * due set lives in the database, a run scheduled before a restart is picked up
 * on the next tick after the process comes back — long delays survive restarts.
 *
 * Returns the number of runs claimed for resumption this tick.
 */
export const runDueScheduledResumptions = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();

  let due: InstanceType<typeof db.OrchestrationRun>[];
  try {
    due = await db.OrchestrationRun.findAll({
      where: { status: 'running', resumeAt: { [Op.lte]: now } },
      order: [['resumeAt', 'ASC']],
      limit: BATCH_LIMIT,
    });
  } catch (error) {
    log('runDueScheduledResumptions: query failed %o', error);
    return 0;
  }

  let claimedCount = 0;
  for (const run of due) {
    const runId = run.id as number;
    if (inFlight.has(runId)) continue;

    // Atomic claim: clearing resumeAt guarded on it still being set ensures a
    // single resumption even with overlapping ticks or multiple workers.
    const [claimed] = await db.OrchestrationRun.update(
      { resumeAt: null },
      { where: { id: runId, resumeAt: { [Op.ne]: null } } }
    );
    if (!claimed) continue;

    inFlight.add(runId);
    claimedCount += 1;
    void resumeScheduledRun({ run })
      .catch((error: unknown) => {
        log(
          'runDueScheduledResumptions: resume failed runId=%s %o',
          runId,
          error
        );
      })
      .finally(() => {
        inFlight.delete(runId);
      });
  }

  return claimedCount;
};

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the background scheduler loop. Skipped under NODE_ENV=test, where tests
 * invoke {@link runDueScheduledResumptions} directly for determinism. The timer
 * is unref'd so it never keeps the process alive on its own.
 */
export const initializeOrchestrationScheduler = (args?: {
  intervalMs?: number;
}): void => {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return;
  if (timer) return;

  const intervalMs =
    args?.intervalMs ?? Number(process.env.ORCHESTRATION_SCHEDULER_INTERVAL_MS);
  const resolvedInterval =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_INTERVAL_MS;

  log('initializeOrchestrationScheduler: interval=%dms', resolvedInterval);
  timer = setInterval(() => {
    void runDueScheduledResumptions();
  }, resolvedInterval);
  timer.unref?.();
};
