import 'dotenv/config';

import { initialize } from '@ttoss/postgresdb';

import * as dbModule from '../src/db';
import { buildDatabaseConfig, type DB } from '../src/db';
import {
  backfillSystemPaths,
  countUnmigratedSystemPaths,
} from '../src/lib/systemPathBackfill';

/**
 * Files what the runtime wrote before `/.system/` existed under it.
 *
 * ```bash
 * BACKFILL_DRY_RUN=1 pnpm --filter @soat/server backfill-system-paths
 * pnpm --filter @soat/server backfill-system-paths
 * ```
 *
 * Run it once per deployment after upgrading. Until it has run, a conversation
 * message written earlier stays outside `/.system/`, so an unfiltered document
 * list and a bare knowledge query still return it.
 */
const main = async (): Promise<void> => {
  const db = await initialize(buildDatabaseConfig());
  // The lib modules read the shared `db` binding rather than receiving one.
  (dbModule as { db: DB }).db = db;

  /* eslint-disable no-console */
  if (process.env.BACKFILL_DRY_RUN === '1') {
    const pending = await countUnmigratedSystemPaths();
    console.log(
      `would move ${pending.messages} conversation message(s) and ${pending.traces} trace object(s)`
    );
  } else {
    const result = await backfillSystemPaths();
    console.log(
      `moved ${result.messages} conversation message(s) and ${result.traces} trace object(s)`
    );
    for (const conflict of result.conflicts) {
      console.log(`left in place — a file already occupies ${conflict}`);
    }
  }
  /* eslint-enable no-console */

  await db.sequelize.close();
};

void main();
