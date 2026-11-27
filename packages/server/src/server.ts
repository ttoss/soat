import 'dotenv/config';

import createDebug from 'debug';

import pkg from '../package.json' with { type: 'json' };
import { app } from './app';
import { initializeDatabase, logDatabaseConnectionError } from './db';
import { startApprovalScheduler } from './lib/approvalScheduler';
import { startAuditRetentionScheduler } from './lib/auditScheduler';
import { loadBootConfigOrExit } from './lib/bootConfig';
import { startContentRetentionScheduler } from './lib/contentRetentionScheduler';
import { startDecisionsScheduler } from './lib/decisionsScheduler';
import { startEvalWorker } from './lib/evaluationWorker';
import { startFileExpiryScheduler } from './lib/fileDeletion';
import { startGenerationSweepScheduler } from './lib/generationSweep';
import { backfillKnowledgeConfigCasing } from './lib/knowledgeConfigBackfill';
import { loggableError } from './lib/loggableError';
import { startOrchestrationScheduler } from './lib/orchestrationScheduler';
import { startOrchestrationWorker } from './lib/orchestrationWorker';
import { startPlaybookScheduler } from './lib/playbookCascade';
import { applyServerTimeouts } from './lib/serverTimeouts';
import { startTasksScheduler } from './lib/tasksScheduler';
import { startTriggerScheduler } from './lib/triggerScheduler';
import { backfillUsageRenames } from './lib/usageRenameBackfill';
import { startUsageRequestScheduler } from './lib/usageRequestScheduler';
import { startUsageStorageScheduler } from './lib/usageStorageScheduler';
import { createFirstAdminUser } from './lib/users';
import { startWebhookScheduler } from './lib/webhookDispatcher';
import { prepareSchemaOrExit } from './schema';

const log = createDebug('soat:server');

/**
 * SOAT = 5047
 */
const SOAT_PORT = process.env.PORT || 5047;

const startServer = async () => {
  loadBootConfigOrExit();

  try {
    const database = await initializeDatabase(app);
    // Schema DDL is a pre-deploy step: boot binds its port in seconds
    // and only checks that the step has run. DB_SYNC=true opts a deployment
    // that has no such step — a single container against its own database —
    // back into preparing the schema here, serialized on the advisory locks.
    await prepareSchemaOrExit({ sequelize: database.sequelize });
    // Normalizes `knowledge_config` bags stored in camelCase. Idempotent and
    // prefiltered in SQL, so a converged database pays a single indexless scan
    // and writes nothing.
    await backfillKnowledgeConfigCasing();
    // Rewrites stored policy / guardrail / formation documents that name a
    // usage string under a retired spelling. Same shape: idempotent,
    // prefiltered in SQL, and a converged database writes nothing.
    await backfillUsageRenames();
    // Start the durable orchestration scheduler once the database is ready so
    // it can wake sleeping runs whose delay/poll waits are due (including runs
    // that were parked before a restart).
    startOrchestrationScheduler();
    // Makes this API process a valid single-process worker, draining the tasks
    // the scheduler and start-run enqueue. `ORCHESTRATION_WORKER_DISABLED`
    // turns it off for a dedicated worker fleet.
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
    // Settles decisions a restart left unsettled.
    startDecisionsScheduler();
    // Fails generations whose process stopped renewing their lease.
    startGenerationSweepScheduler();
    // Runs queued playbook node executions, and recovers ones a restart left
    // running or whose task or run ended without an event.
    startPlaybookScheduler();
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
    // Deletes files past their `expires_at`; reads already treat them as gone.
    startFileExpiryScheduler();
    // Start the daily storage-metering snapshot (one `storage` usage event per
    // project per UTC day) and the API-request counter flush (aggregated
    // `api_request` events per window).
    startUsageStorageScheduler();
    startUsageRequestScheduler();
    // Executes async eval runs' items, and reaps runs a disconnected client
    // left mid-flight instead of leaving them `running` forever.
    // `EVAL_WORKER_DISABLED` turns it off for a dedicated worker fleet.
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
        loggableError(error)
      );
    }
  }

  const server = app.listen(SOAT_PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `startServer: server ${pkg.version} running on http://localhost:${SOAT_PORT}`
    );
  });

  applyServerTimeouts({ server });
};

startServer();
