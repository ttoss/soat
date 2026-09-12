import { models } from '@soat/postgresdb';
import type { Sequelize } from '@ttoss/postgresdb';
import { initialize } from '@ttoss/postgresdb';
import { app } from 'src/app';
import { initializeDatabase } from 'src/db';

import {
  createTestDatabase,
  dropTestDatabase,
  readTestDatabaseConnection,
} from './testDatabase';

/**
 * Registers the per-file database lifecycle on the surrounding suite: clone the
 * template `globalSetup` built, initialize the app against the clone, and drop
 * it afterwards.
 *
 * Shared by the unit suite and the retrieval eval — both want exactly this
 * isolation, and a second copy of it would quietly drift from whichever one was
 * changed next.
 *
 * `onReady` hands the connection back rather than the helper exporting it: the
 * unit suite re-exports a live `sequelize` binding that many tests import, and
 * that binding has to stay in `setupTestsAfterEnv.ts` where they already read
 * it from.
 */
export const installTestDatabase = (args?: {
  onReady?: (sequelize: Sequelize) => void;
}) => {
  const connection = readTestDatabaseConnection();
  let sequelize: Sequelize | undefined;
  let database: string | undefined;

  beforeAll(async () => {
    try {
      database = await createTestDatabase({ connection });

      const db = await initialize({
        models,
        logging: false,
        ...connection,
        database,
      });

      await initializeDatabase(app);

      sequelize = db.sequelize;
      args?.onReady?.(db.sequelize);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error during database initialization:', error);
      throw error;
    }
  });

  afterAll(async () => {
    await sequelize?.close();

    if (database) {
      await dropTestDatabase({ connection, database });
    }
  });
};
