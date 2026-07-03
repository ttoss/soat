import 'dotenv/config';

import createDebug from 'debug';

import pkg from '../package.json' assert { type: 'json' };
import { app } from './app';
import { initializeDatabase } from './db';
import { initializeOrchestrationScheduler } from './lib/orchestrationScheduler';
import { createFirstAdminUser } from './lib/users';

const log = createDebug('soat:server');

/**
 * SOAT = 5047
 */
const SOAT_PORT = process.env.PORT || 5047;

const startServer = async () => {
  try {
    const database = await initializeDatabase(app);
    await database.sequelize.sync({ alter: true });
    // Start the durable orchestration scheduler once the database is ready so
    // it can resume runs whose delay/poll waits are due (including runs that
    // were parked before a restart).
    initializeOrchestrationScheduler();
  } catch (error) {
    log('startServer: failed to connect to database error=%o', error);
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
