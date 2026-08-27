import createDebug from 'debug';

import { db } from '../db';
import {
  type ClaimedTask,
  getOrchestrationQueueDriver,
} from './orchestration-queue-drivers';
import { driveQueuedRun, redriveRun, wakeRun } from './orchestrationEngine';
import { writeWorkerHeartbeat } from './orchestrationWorkerHealth';
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

// Tracked across ticks so the concurrency cap holds when a slow task spans
// several: each tick may claim at most `CONCURRENCY − inFlight`.
let inFlight = 0;

/** The tasks currently claimed-and-unacked by this worker process. */
export const inFlightTaskCount = (): number => {
  return inFlight;
};

// A failed claim deliberately does not update this, so the value ages out and
// the healthcheck reports unhealthy — a worker whose timer fires but cannot
// reach the queue is not doing its job.
let lastSuccessfulDrainAt: number | null = null;

/**
 * Epoch milliseconds of this process's last successful queue claim, or `null`
 * if it has not completed one yet. The liveness signal behind the worker
 * heartbeat file (see {@link writeWorkerHeartbeat}).
 */
export const lastSuccessfulDrainAtMs = (): number | null => {
  return lastSuccessfulDrainAt;
};

/** Test-only: forgets the last successful drain so liveness starts cold. */
export const resetLastSuccessfulDrain = (): void => {
  lastSuccessfulDrainAt = null;
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
  task: ClaimedTask;
}): Promise<void> => {
  const { task } = args;
  const run = await db.OrchestrationRun.findByPk(task.orchestrationRunId);
  if (!run) {
    log(
      'handleRunTask: run %d gone, acking task %s',
      task.orchestrationRunId,
      task.id
    );
    return;
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    log(
      'handleRunTask: run %s already %s, acking task %s',
      run.publicId,
      run.status,
      task.id
    );
    return;
  }

  log(
    'handleRunTask: task=%s kind=%s run=%s status=%s',
    task.id,
    task.kind,
    run.publicId,
    run.status
  );

  if (task.kind === 'wake') {
    await wakeRun({ run });
    return;
  }
  // A `running` run here is one the reaper reclaimed after a crash.
  // Request-driven resumes drive inline and never enqueue a task, so no
  // `resume` kind is produced today.
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

  const driver = getOrchestrationQueueDriver();

  let tasks: ClaimedTask[];
  try {
    tasks = await driver.claim({ limit, now: args?.now });
  } catch (error) {
    log('drainQueueOnce: claim failed %o', error);
    return 0;
  }

  // A completed claim (even an empty one) proves this process can still reach
  // the queue — the liveness signal the worker healthcheck reads.
  lastSuccessfulDrainAt = (args?.now ?? new Date()).getTime();

  inFlight += tasks.length;

  await Promise.all(
    tasks.map(async (task) => {
      try {
        await handleRunTask({ task });
        await driver.ack({ task });
      } catch (error) {
        // Leave the task un-acked so its lease expires and it is redelivered.
        log('drainQueueOnce: handle failed task=%s %o', task.id, error);
      } finally {
        inFlight -= 1;
      }
    })
  );

  return tasks.length;
};

// Lets a single-process deployment drive the queue without a separate worker.
// `ORCHESTRATION_WORKER_DISABLED=true` keeps the API tier request-only for
// deployments running a dedicated worker fleet.
export const kickWorker = (): void => {
  if (process.env.ORCHESTRATION_WORKER_DISABLED === 'true') return;
  // `drainQueueOnce` catches its own claim and per-task errors and resolves to a
  // count, so this fire-and-forget kick never rejects.
  void drainQueueOnce();
};

/**
 * Publishes this process's liveness to the heartbeat file after the drain, so a
 * container healthcheck can tell a working worker from a wedged one. A no-op
 * unless `ORCHESTRATION_WORKER_HEARTBEAT_FILE` is set, so the in-API worker
 * writes nothing by default. Returns 0 to satisfy the `Sweep` contract.
 */
export const publishWorkerHeartbeat = async (): Promise<number> => {
  await writeWorkerHeartbeat({
    lastSuccessfulDrainAtMs: lastSuccessfulDrainAt,
  });
  return 0;
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5000,
  envVar: 'ORCHESTRATION_WORKER_INTERVAL_MS',
  disabledEnvVar: 'ORCHESTRATION_WORKER_DISABLED',
  // The first sweep is the queue drain — its `(args?: { now? })` signature is a
  // superset of the Sweep contract, so it is used directly. The second
  // publishes the heartbeat the worker healthcheck reads.
  sweeps: [drainQueueOnce, publishWorkerHeartbeat],
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
