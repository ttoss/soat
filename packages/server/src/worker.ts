import 'dotenv/config';

import createDebug from 'debug';

import { app } from './app';
import {
  initializeDatabase,
  logDatabaseConnectionError,
  syncSchemaWithAdvisoryLock,
} from './db';
import { startOrchestrationScheduler } from './lib/orchestrationScheduler';
import { startOrchestrationWorker } from './lib/orchestrationWorker';

const log = createDebug('soat:worker');

/**
 * Standalone orchestration worker entrypoint (Phase 1, D4).
 *
 * Starts only the scheduler tick (which enqueues `wake`/`continue` tasks for due
 * and orphaned runs) and the worker loop (which claims and drives those tasks) —
 * no HTTP listener. This proves the "separate-process worker" option is real:
 * `node worker.ts` drains a queue to completion with the API process stopped.
 *
 * Deploy/ops hardening (compose service, healthcheck, graceful shutdown) is
 * deferred to Phase 2, when concurrency limits make a real worker fleet
 * meaningful. Run the API tier with `ORCHESTRATION_WORKER_DISABLED=true` so it
 * stays request-only and this process owns draining.
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

startWorker();
