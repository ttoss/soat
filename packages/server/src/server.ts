import 'dotenv/config';

import createDebug from 'debug';

import pkg from '../package.json' with { type: 'json' };
import { app } from './app';
import {
  initializeDatabase,
  logDatabaseConnectionError,
  syncSchemaWithAdvisoryLock,
} from './db';
import { startApprovalScheduler } from './lib/approvalScheduler';
import { startAuditRetentionScheduler } from './lib/auditScheduler';
import { startContentRetentionScheduler } from './lib/contentRetentionScheduler';
import { startEvalWorker } from './lib/evaluationWorker';
import { startOrchestrationScheduler } from './lib/orchestrationScheduler';
import { startOrchestrationWorker } from './lib/orchestrationWorker';
import { startTasksScheduler } from './lib/tasksScheduler';
import { startTriggerScheduler } from './lib/triggerScheduler';
import { startUsageRequestScheduler } from './lib/usageRequestScheduler';
import { startUsageStorageScheduler } from './lib/usageStorageScheduler';
import { createFirstAdminUser } from './lib/users';
import { startWebhookScheduler } from './lib/webhookDispatcher';

const log = createDebug('soat:server');

/**
 * SOAT = 5047
 */
const SOAT_PORT = process.env.PORT || 5047;

const startServer = async () => {
  try {
    const database = await initializeDatabase(app);
    // Serialize boot-time schema DDL across concurrently-starting tasks so
    // sync({ alter: true }) runs exactly once and the rest see a no-op.
    await syncSchemaWithAdvisoryLock({ sequelize: database.sequelize });
    // Start the durable orchestration scheduler once the database is ready so
    // it can wake sleeping runs whose delay/poll waits are due (including runs
    // that were parked before a restart).
    startOrchestrationScheduler();
    // Start the in-process orchestration queue worker so this API process is a
    // valid single-process worker: it drains `continue`/`wake` tasks the
    // scheduler and start-run enqueue. Disable with ORCHESTRATION_WORKER_DISABLED
    // when running a dedicated worker fleet (see worker.ts).
    startOrchestrationWorker();
    // Start the approvals expiry sweeper so pending approval items past their
    // expiry are flipped to `expired` and can never execute late.
    startApprovalScheduler();
    // Start the trigger scheduler so due schedule triggers fire (including
    // occurrences whose next_fire_at elapsed while the server was down).
    startTriggerScheduler();
    // Start the task stall sweeper so tasks parked past their `stalled_after`
    // threshold emit `tasks.stalled` (once per episode, re-armed on transition).
    startTasksScheduler();
    // Start the webhook delivery outbox sweep so failed deliveries are retried
    // behind their backoff, and so deliveries interrupted mid-attempt by a
    // restart are reclaimed once their lease expires instead of being stranded.
    startWebhookScheduler();
    // Start the audit-log retention sweep so entries older than
    // AUDIT_RETENTION_DAYS are pruned on a daily tick.
    startAuditRetentionScheduler();
    // Start the trace-content retention sweep so content past a project's
    // trace_content_retention_days is purged on a daily tick. Projects that
    // leave the window null are skipped — retention is opt-in.
    startContentRetentionScheduler();
    // Start the daily storage-metering snapshot (one `storage` usage event per
    // project per UTC day) and the API-request counter flush (aggregated
    // `api_request` events per window).
    startUsageStorageScheduler();
    startUsageRequestScheduler();
    // Start the eval worker so asynchronous eval runs (`wait: false`) execute
    // their items, and so runs left mid-flight by a disconnected client are
    // reaped instead of sitting `running` forever. Disable with
    // EVAL_WORKER_DISABLED when a dedicated worker fleet owns draining.
    startEvalWorker();
  } catch (error) {
    // This is a fatal, process-terminating failure, so print to stderr
    // unconditionally rather than via the opt-in `debug` logger — otherwise the
    // process would `exit 1` with no output unless DEBUG happened to be set.
    logDatabaseConnectionError(error);
    process.exit(1);
  }

  const adminUsername = process.env.SOAT_ADMIN_USERNAME;
  const adminPassword = process.env.SOAT_ADMIN_PASSWORD;

  if (adminUsername && adminPassword) {
    try {
      const user = await createFirstAdminUser({
        username: adminUsername,
        password: adminPassword,
      });

      if (user) {
        log('startServer: admin user created from environment variables');
      }
    } catch (error) {
      log(
        'startServer: failed to create admin user from environment variables error=%o',
        error
      );
    }
  }

  const server = app.listen(SOAT_PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `startServer: server ${pkg.version} running on http://localhost:${SOAT_PORT}`
    );
  });

  // Disable the default 5-minute requestTimeout so long-running LLM
  // generations (which can take many minutes) are not forcibly terminated.
  server.requestTimeout = 0;
};

startServer();
