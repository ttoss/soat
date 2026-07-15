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
import { startOrchestrationScheduler } from './lib/orchestrationScheduler';
import { seedDefaultPrices } from './lib/priceBook';
import { startTriggerScheduler } from './lib/triggerScheduler';
import { createFirstAdminUser } from './lib/users';

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
    // Seed the shipped default price rows so usage cost is computed out of the
    // box; idempotent, so operator overrides are never clobbered on restart.
    await seedDefaultPrices();
    // Start the durable orchestration scheduler once the database is ready so
    // it can wake sleeping runs whose delay/poll waits are due (including runs
    // that were parked before a restart).
    startOrchestrationScheduler();
    // Start the approvals expiry sweeper so pending approval items past their
    // expiry are flipped to `expired` and can never execute late.
    startApprovalScheduler();
    // Start the trigger scheduler so due schedule triggers fire (including
    // occurrences whose next_fire_at elapsed while the server was down).
    startTriggerScheduler();
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
