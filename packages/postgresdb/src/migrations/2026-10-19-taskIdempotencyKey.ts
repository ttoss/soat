import { defineMigration } from '@ttoss/postgresdb';

const COLUMNS = [
  { column: 'idempotency_key', type: 'varchar(255)' },
  { column: 'idempotency_digest', type: 'varchar(64)' },
];

/**
 * A task create's idempotency key and request digest, on the task it wrote.
 * `sync` never alters an existing table, so the columns are a migration; the
 * unique index over `(project_id, idempotency_key)` is the model's and built by
 * the sync.
 */
export const taskIdempotencyKey = defineMigration({
  name: '2026-10-19-task-idempotency-key',
  description:
    'tasks.idempotency_key, unique per project, and tasks.idempotency_digest, so a retried task create replays instead of creating a second task.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'tasks' }))) return true;
    for (const { column } of COLUMNS) {
      if (!(await context.columnExists({ table: 'tasks', column }))) {
        return false;
      }
    }
    return true;
  },
  up: async (context) => {
    for (const { column, type } of COLUMNS) {
      context.say(`adding tasks.${column}`);
      await context.addColumnIfMissing({ table: 'tasks', column, type });
    }
  },
});
