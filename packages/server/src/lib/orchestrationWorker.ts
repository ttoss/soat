import createDebug from 'debug';

import { db } from '../db';
import { driveQueuedRun, redriveRun, wakeRun } from './orchestrationEngine';
import {
  ackRunTask,
  claimRunTasks,
  type RunTaskInstance,
} from './orchestrationQueue';
import { createScheduler } from './scheduler';

const log = createDebug('soat:orchestrations');

const DEFAULT_WORKER_BATCH = 10;

const workerBatchLimit = (): number => {
  const configured = Number(process.env.ORCHESTRATION_WORKER_BATCH);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKER_BATCH;
};

/**
 * The global per-worker-process concurrency cap (`ORCHESTRATION_WORKER_CONCURRENCY`,
 * D10): the maximum number of simultaneously claimed, unacked tasks this process
 * may hold at any instant, across ticks. Unset (or invalid) means no cross-tick
 * cap — today's behavior, bounded only by the per-tick batch size. A fleet of P
 * workers bounds global concurrency at `P × CONCURRENCY`.
 */
const workerConcurrencyLimit = (): number | undefined => {
  const configured = Number(process.env.ORCHESTRATION_WORKER_CONCURRENCY);
  return Number.isFinite(configured) && configured > 0 ? configured : undefined;
};

// Number of tasks this process has claimed but not yet acked. Tracked across
// ticks so the concurrency cap holds even when a slow task spans several ticks:
// each tick may claim at most `CONCURRENCY − inFlight`. Module-level (per
// process), matching the per-worker semantics of D10.
let inFlight = 0;

/** The tasks currently claimed-and-unacked by this worker process. */
export const inFlightTaskCount = (): number => {
  return inFlight;
};

/**
 * The number of tasks this tick may claim: the per-tick `batch` size, further
 * bounded by the cross-tick concurrency headroom (`concurrency − inFlight`)
 * when a global cap is set (D10). `undefined` concurrency means no cross-tick
 * cap — just the batch. Never negative. Pure; the single source of truth for
 * the claim size shared by `drainQueueOnce` and its tests.
 */
export const effectiveClaimLimit = (args: {
  batch: number;
  concurrency: number | undefined;
  inFlight: number;
}): number => {
  if (args.concurrency === undefined) return args.batch;
  const remaining = args.concurrency - args.inFlight;
  if (remaining <= 0) return 0;
  return Math.min(args.batch, remaining);
};

// A run in one of these states has nothing to drive: the task is a no-op left
// over from a cancel or a completed drive, so the worker just acks it.
const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

/**
 * Drives one claimed task: loads its run, dispatches to the matching engine
 * entry point by kind and current run status, then the caller acks. A task
 * whose run has vanished or already reached a terminal state is a no-op (the
 * run was cancelled or already driven) — it is simply acked.
 *
 * The engine functions catch their own execution failures and settle the run as
 * `failed`, so a normal drive resolves; this only rethrows on an unexpected
 * infrastructure error, which leaves the task un-acked for lease-based
 * redelivery.
 */
export const handleRunTask = async (args: {
  task: RunTaskInstance;
}): Promise<void> => {
  const { task } = args;
  const run = await db.OrchestrationRun.findByPk(task.runId as number);
  if (!run) {
    log('handleRunTask: run %d gone, acking task %d', task.runId, task.id);
    return;
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    log(
      'handleRunTask: run %s already %s, acking task %d',
      run.publicId,
      run.status,
      task.id
    );
    return;
  }

  log(
    'handleRunTask: task=%s kind=%s run=%s status=%s',
    task.publicId,
    task.kind,
    run.publicId,
    run.status
  );

  if (task.kind === 'wake') {
    await wakeRun({ run });
    return;
  }
  // `continue` (and any future `resume`): a freshly-queued run starts from
  // scratch; a `running` run is one the reaper reclaimed after a crash and
  // re-drives from its last checkpoint. Request-driven resumes (human input,
  // manual resume, approval resolution) drive inline and never enqueue a task,
  // so a `resume` kind is not produced today.
  if (run.status === 'queued') {
    await driveQueuedRun({ run });
    return;
  }
  await redriveRun({ run });
};

/**
 * Claims one batch of due tasks and drives each to its next resting point,
 * acking on completion. Tasks in a batch are driven concurrently; a task whose
 * handler throws is left un-acked (its lease expires → redelivery) while the
 * rest still ack. Returns the number of tasks claimed this call.
 */
export const drainQueueOnce = async (args?: {
  limit?: number;
  now?: Date;
}): Promise<number> => {
  const batch = args?.limit ?? workerBatchLimit();

  // Cross-tick concurrency cap (D10): never let claimed-and-unacked tasks exceed
  // CONCURRENCY. The effective claim size this tick is `min(batch, remaining)`;
  // when the process is already at the cap this is 0 and the claim returns none.
  const limit = effectiveClaimLimit({
    batch,
    concurrency: workerConcurrencyLimit(),
    inFlight,
  });

  let tasks: RunTaskInstance[];
  try {
    tasks = await claimRunTasks({ limit, now: args?.now });
  } catch (error) {
    log('drainQueueOnce: claim failed %o', error);
    return 0;
  }

  inFlight += tasks.length;

  await Promise.all(
    tasks.map(async (task) => {
      try {
        await handleRunTask({ task });
        await ackRunTask({ id: task.id as number });
      } catch (error) {
        // Leave the task un-acked so its lease expires and it is redelivered.
        log('drainQueueOnce: handle failed task=%d %o', task.id, error);
      } finally {
        inFlight -= 1;
      }
    })
  );

  return tasks.length;
};

// In-process worker kick. `enqueueRunTask` callers (start-run, the scheduler
// sweeps) fire this so a single-process deployment drives the queue without a
// separate worker — the API process is itself a valid worker. Disabled by
// `ORCHESTRATION_WORKER_DISABLED=true` for deployments that run a dedicated
// worker fleet and want the API tier to stay request-only.
export const kickWorker = (): void => {
  if (process.env.ORCHESTRATION_WORKER_DISABLED === 'true') return;
  // `drainQueueOnce` catches its own claim and per-task errors and resolves to a
  // count, so this fire-and-forget kick never rejects.
  void drainQueueOnce();
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5000,
  envVar: 'ORCHESTRATION_WORKER_INTERVAL_MS',
  disabledEnvVar: 'ORCHESTRATION_WORKER_DISABLED',
  // The sweep is the queue drain — its `(args?: { now? })` signature is a
  // superset of the Sweep contract, so it is used directly.
  sweeps: [drainQueueOnce],
});

/**
 * Starts the background worker loop that drains the orchestration queue on an
 * interval. Runs inside the API process by default (single-process worker) and
 * is also the loop the standalone `worker.ts` entrypoint starts. Repeated calls
 * are a no-op and the timer is unref'd.
 */
export const startOrchestrationWorker = scheduler.start;

/** Stops the background worker loop (graceful shutdown / test teardown). */
export const stopOrchestrationWorker = scheduler.stop;
