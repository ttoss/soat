import { defineMigration } from '@ttoss/postgresdb';

/**
 * `orchestration_runs.idempotency_key` lets a caller retry an ambiguous
 * timeout on run start without risking a second paid run.
 *
 * `sync` creates missing tables and never alters one that exists, so the column
 * is a migration; the unique index over `(project_id, idempotency_key)` is
 * declared by the model and built by the sync this calls once the column
 * exists.
 */
export const orchestrationRunIdempotencyKey = defineMigration({
  name: '2026-09-18-orchestration-run-idempotency-key',
  description:
    'orchestration_runs.idempotency_key, unique per project, so a retried run start cannot start a second run.',
  /**
   * Every probe runs before any `up`, so this answers for the database as it
   * stands. A database with no `orchestration_runs` at all is one `sync` will
   * build from the models, and migrations run before that sync — the column
   * arrives with the table, so this records rather than replays.
   */
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'orchestration_runs' }))) {
      return true;
    }
    return context.columnExists({
      table: 'orchestration_runs',
      column: 'idempotency_key',
    });
  },
  up: async (context) => {
    context.say('adding orchestration_runs.idempotency_key');
    await context.addColumnIfMissing({
      table: 'orchestration_runs',
      column: 'idempotency_key',
      type: 'varchar(255)',
    });
    await context.sync();
  },
});
