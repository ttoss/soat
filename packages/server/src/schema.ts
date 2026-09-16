import { MIGRATIONS } from '@soat/postgresdb';
import type { MigrationRunnerOptions, Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner, DEFAULT_LEDGER_TABLE } from '@ttoss/postgresdb';
import createDebug from 'debug';

import pkg from '../package.json' with { type: 'json' };
import { getSchemaSyncLockTimeoutMs, syncSchemaWithAdvisoryLock } from './db';

const log = createDebug('soat:schema');

export const MIGRATE_COMMAND = 'node packages/server/dist/migrate.mjs run';

/**
 * Whether boot performs the schema DDL itself.
 *
 * Off by default (#548): `sync({ alter: true })` is `await`ed before
 * `app.listen`, so on a schema-changing release against a populated database a
 * task could not answer `/health` for minutes and an orchestrator that
 * health-gates the rollout killed it first. Schema changes are a discrete
 * pre-deploy step now, and an ordinary boot only checks that the step has run.
 *
 * Exactly `'true'` opens it: a gate that opened on any truthy-looking value
 * would put the slow boot back on a deployment that meant to turn it off.
 */
export const isBootSchemaSyncEnabled = (): boolean => {
  return process.env.DB_SYNC === 'true';
};

const isPresenceRow = (row: unknown): row is { present: boolean } => {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as Record<string, unknown>).present === 'boolean'
  );
};

const isNameRow = (row: unknown): row is { name: string } => {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as Record<string, unknown>).name === 'string'
  );
};

/**
 * The declared migrations the ledger has no row for.
 *
 * Deliberately reads the ledger rather than asking the runner for a status
 * report: the runner creates the table it reads, and `CREATE TABLE IF NOT
 * EXISTS` is no more race-safe than `CREATE EXTENSION IF NOT EXISTS` — every
 * task of a rolling deploy runs this, so one of them would lose on `pg_class`
 * and fail a boot that had nothing wrong with it. This writes nothing.
 */
export const pendingMigrationNames = async (args: {
  sequelize: Sequelize;
}): Promise<string[]> => {
  const declared = MIGRATIONS.map((migration) => {
    return migration.name;
  });

  const [presence] = await args.sequelize.query(
    'SELECT to_regclass(:table) IS NOT NULL AS present',
    { replacements: { table: `public.${DEFAULT_LEDGER_TABLE}` } }
  );

  const [presenceRow] = presence;

  if (!isPresenceRow(presenceRow) || !presenceRow.present) {
    return declared;
  }

  const [rows] = await args.sequelize.query(
    `SELECT "name" FROM ${DEFAULT_LEDGER_TABLE}`
  );

  const applied = new Set(
    rows.filter(isNameRow).map((row) => {
      return row.name;
    })
  );

  return declared.filter((name) => {
    return !applied.has(name);
  });
};

/**
 * Fails the boot when the database is behind the code about to serve it. With
 * the sync off nothing else would notice: the models would describe tables and
 * columns the database has not got, and the first request to touch one would
 * be the error report.
 */
export const assertSchemaPrepared = async (args: {
  sequelize: Sequelize;
}): Promise<void> => {
  const pending = await pendingMigrationNames(args);

  if (pending.length === 0) {
    return;
  }

  throw new Error(
    `The database is missing ${pending.length} schema migration(s): ${pending.join(', ')}. ` +
      `Run \`${MIGRATE_COMMAND}\` as a pre-deploy step before starting the server, ` +
      'or set DB_SYNC=true to let this process perform the schema changes itself.'
  );
};

/**
 * What both the migrate entrypoint and the boot-time path build a runner from,
 * so the two can never drift into migrating differently.
 *
 * `sync` is the plain sync rather than the advisory-locked one: a migration
 * that calls `context.sync()` does so while the migration lock is held, and
 * taking a second lock underneath it could deadlock against a peer that holds
 * the two in the other order.
 */
export const schemaRunnerOptions = (args: {
  sequelize: Sequelize;
}): MigrationRunnerOptions => {
  return {
    migrations: MIGRATIONS,
    sequelize: args.sequelize,
    sync: async () => {
      await args.sequelize.sync({ alter: true });
    },
    version: pkg.version,
    lockTimeoutMs: getSchemaSyncLockTimeoutMs(),
    log: (message) => {
      // Unconditional rather than through the opt-in `debug` logger: this is a
      // deploy step, and its output is the record of what it changed.
      process.stderr.write(`${message}\n`);
    },
  };
};

export const createSchemaMigrationRunner = (args: { sequelize: Sequelize }) => {
  return createMigrationRunner(schemaRunnerOptions(args));
};

/**
 * Prepares the schema: the migrations `sync` cannot perform, then the sync.
 *
 * That order inverts the guideline's default and is load-bearing —
 * `2026-09-16-memories-rename-and-provenance` renames a table the models
 * already describe under its new name, so a sync running first would create an
 * empty `memory_stores` beside the populated `memories` and then fail building
 * an index over a column the old table has not got.
 *
 * The two steps take different advisory locks, sequentially and never nested,
 * so concurrent runners serialize on each without deadlocking one another.
 */
export const prepareSchema = async (args: {
  sequelize: Sequelize;
  dryRun?: boolean;
}): Promise<void> => {
  await createSchemaMigrationRunner(args).run({ dryRun: args.dryRun === true });

  if (args.dryRun === true) {
    log('prepareSchema: dry run, leaving the schema sync alone');

    return;
  }

  await syncSchemaWithAdvisoryLock({ sequelize: args.sequelize });
};

/**
 * What boot calls: prepare the schema, or refuse to serve a database that is
 * behind. Lives here rather than as an `if` in each entrypoint so the API tier
 * and the worker fleet can never disagree about what a boot is allowed to do.
 */
export const prepareOrAssertSchema = async (args: {
  sequelize: Sequelize;
}): Promise<void> => {
  if (isBootSchemaSyncEnabled()) {
    await prepareSchema(args);

    return;
  }

  await assertSchemaPrepared(args);
};

/**
 * The boot step itself: prepare or refuse, and end the process on refusal.
 *
 * Both entrypoints call this one statement rather than branching inline —
 * `startServer` is already at the complexity ceiling, and a schema gate that
 * differed between the API tier and the worker fleet would be a bug nothing
 * else would catch.
 */
export const prepareSchemaOrExit = async (args: {
  sequelize: Sequelize;
}): Promise<void> => {
  try {
    await prepareOrAssertSchema(args);
  } catch (error) {
    // A schema that is behind is not a connection failure, and reporting it as
    // one sends an operator to the wrong place entirely. Unconditional stderr
    // rather than the opt-in `debug` logger: this terminates the process.
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
