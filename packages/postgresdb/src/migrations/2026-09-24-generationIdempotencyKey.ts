import { defineMigration } from '@ttoss/postgresdb';

/**
 * `generations.idempotency_key` and `generations.idempotency_digest` let a
 * caller retry an agent generation without running the agent twice.
 *
 * `sync` creates missing tables and never alters one that exists, so the
 * columns are a migration. The unique index over `(project_id,
 * idempotency_key)` is declared by the model and built by the schema sync
 * `prepareSchema` runs after every migration.
 */
export const generationIdempotencyKey = defineMigration({
  name: '2026-09-24-generation-idempotency-key',
  description:
    'generations.idempotency_key, unique per project, and the digest of the request it names, so a retried generation cannot run the agent twice.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'generations' }))) {
      return true;
    }
    return context.columnExists({
      table: 'generations',
      column: 'idempotency_digest',
    });
  },
  up: async (context) => {
    context.say('adding generations.idempotency_key and idempotency_digest');
    await context.addColumnIfMissing({
      table: 'generations',
      column: 'idempotency_key',
      type: 'varchar(255)',
    });
    await context.addColumnIfMissing({
      table: 'generations',
      column: 'idempotency_digest',
      type: 'varchar(64)',
    });
  },
});
