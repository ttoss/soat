import 'dotenv/config';

import createDebug from 'debug';

import { app } from './app';
import {
  initializeDatabase,
  logDatabaseConnectionError,
  syncSchemaWithAdvisoryLock,
} from './db';
import {
  startOrchestrationScheduler,
  stopOrchestrationScheduler,
} from './lib/orchestrationScheduler';
import {
  inFlightTaskCount,
  startOrchestrationWorker,
  stopOrchestrationWorker,
} from './lib/orchestrationWorker';

const log = createDebug('soat:worker');

const SHUTDOWN_TIMEOUT_MS = 30_000;
const SHUTDOWN_POLL_MS = 50;

/**
 * Waits for tasks this process has already claimed to finish (be acked), up to
 * `SHUTDOWN_TIMEOUT_MS`. Tasks not finished in time are left un-acked; their
 * lease expires and another worker (or this one on restart) redelivers them, so
 * no work is lost. Resolves with the number of tasks still in flight.
 */
const drainInFlight = async (): Promise<number> => {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (inFlightTaskCount() > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_POLL_MS);
    });
  }
  return inFlightTaskCount();
};

/**
 * Standalone orchestration worker entrypoint (Phase 1, D4).
 *
 * Starts only the scheduler tick (which enqueues `wake`/`continue` tasks for due
 * and orphaned runs) and the worker loop (which claims and drives those tasks) —
 * no HTTP listener. This proves the "separate-process worker" option is real:
 * `node worker.ts` drains a queue to completion with the API process stopped.
 *
 * Global concurrency is capped per process via `ORCHESTRATION_WORKER_CONCURRENCY`
 * (D10); a fleet of P workers bounds it at `P × CONCURRENCY`. On `SIGTERM`/`SIGINT`
 * the process drains gracefully — it stops claiming and waits for already-claimed
 * tasks to finish before exiting (D4). Run the API tier with
 * `ORCHESTRATION_WORKER_DISABLED=true` so it stays request-only and this process
 * owns draining.
 */
const startWorker = async () => {
  try {
    const database = await initializeDatabase(app);
    await syncSchemaWithAdvisoryLock({ sequelize: database.sequelize });
    startOrchestrationScheduler();
    startOrchestrationWorker();
    log('startWorker: orchestration worker running');
  } catch (error) {
    logDatabaseConnectionError(error);
    process.exit(1);
  }
};

// Graceful shutdown: stop the tick so no new tasks are claimed, finish in-flight
// tasks, then exit. Tasks not finished before the timeout are left un-acked and
// redelivered — no work lost.
const gracefulShutdown = (signal: string) => {
  log('gracefulShutdown: received %s, draining', signal);
  stopOrchestrationScheduler();
  stopOrchestrationWorker();
  void drainInFlight().then((remaining) => {
    log('gracefulShutdown: exiting (%d task(s) still in flight)', remaining);
    process.exit(0);
  });
};

process.on('SIGTERM', () => {
  return gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  return gracefulShutdown('SIGINT');
});

startWorker();
