import 'dotenv/config';

import { initialize, parseArgv, runMigrationsCli } from '@ttoss/postgresdb';

import { buildDatabaseConfig, syncSchemaWithAdvisoryLock } from './db';
import { schemaRunnerOptions } from './schema';

/**
 * The schema step a deploy runs before the service rolls (#548).
 *
 * `runMigrationsCli` from `@ttoss/postgresdb` rather than the `migrate` command
 * of `@ttoss/postgresdb-cli`: that command bundles the project's sources on
 * every run, which makes it the local-development face and the wrong thing to
 * put in a container. This runs against the built `dist`.
 *
 * ```
 * node packages/server/dist/migrate.mjs status
 * node packages/server/dist/migrate.mjs run --dry-run
 * node packages/server/dist/migrate.mjs run
 * ```
 */
const main = async () => {
  const argv = process.argv.slice(2);
  const { command, flags } = parseArgv(argv);

  const database = await initialize(buildDatabaseConfig());

  try {
    const code = await runMigrationsCli({
      argv,
      bin: 'migrate',
      ...schemaRunnerOptions({ sequelize: database.sequelize }),
    });

    // The sync follows the migrations, never precedes them: a migration here
    // renames a table the models already describe under its new name, so a
    // sync running first would create an empty one beside the populated
    // original and then fail building an index over a column it has not got.
    if (code === 0 && command === 'run' && flags['dry-run'] !== true) {
      await syncSchemaWithAdvisoryLock({ sequelize: database.sequelize });
    }

    process.exitCode = code;
  } finally {
    await database.sequelize.close();
  }
};

main().catch((error: unknown) => {
  // Fatal and process-terminating, so it goes to stderr unconditionally rather
  // than through the opt-in `debug` logger.
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
