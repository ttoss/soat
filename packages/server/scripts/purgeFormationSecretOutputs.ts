import 'dotenv/config';

import { initialize } from '@ttoss/postgresdb';

import * as dbModule from '../src/db';
import { buildDatabaseConfig, type DB } from '../src/db';
import { purgeFormationSecretOutputs } from '../src/lib/formationSecretPurge';

/**
 * One-off data fix for formations deployed before a `ref_attr` to a signing
 * secret was refused: those deploys wrote the trigger's or webhook's plaintext
 * secret into `formations.outputs`, where it stayed readable to anyone holding
 * `formations:GetFormation`.
 *
 * ```bash
 * PURGE_DRY_RUN=1 pnpm --filter @soat/server purge-formation-secret-outputs
 * pnpm --filter @soat/server purge-formation-secret-outputs
 * ```
 *
 * Run it once per deployment after upgrading. **Then rotate every trigger and
 * webhook signing secret a formation published** — clearing the row ends the
 * exposure but says nothing about who read it while it was there.
 *
 * Idempotent: a second run finds nothing, because what it clears is derived
 * from each formation's own stored template rather than from a marker.
 */
const main = async (): Promise<void> => {
  const db = await initialize(buildDatabaseConfig());
  // The lib modules read the shared `db` binding rather than receiving one.
  (dbModule as { db: DB }).db = db;

  const dryRun = process.env.PURGE_DRY_RUN === '1';
  const result = await purgeFormationSecretOutputs({ dryRun });

  // A CLI script: stdout is the interface.
  /* eslint-disable no-console */
  console.log(
    `${dryRun ? 'would clear' : 'cleared'} ${result.removedOutputs} output(s) across ${result.cleared} of ${result.scanned} formation(s)`
  );
  if (result.cleared > 0) {
    console.log(
      'rotate the trigger and webhook signing secrets those formations published'
    );
  }
  /* eslint-enable no-console */

  await db.sequelize.close();
};

void main();
