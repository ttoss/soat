import { defineMigration } from '@ttoss/postgresdb';

const TABLES = ['task_transitions', 'approval_items'];

const COLUMNS = [
  { column: 'idempotency_key', type: 'varchar(255)' },
  { column: 'idempotency_digest', type: 'varchar(64)' },
];

/**
 * A transition's idempotency key and request digest, on the history row a move
 * writes and on the approval item a parked move writes instead. `sync` never
 * alters an existing table, so the columns are a migration; the unique indexes
 * over `(task_id, idempotency_key)` are the models' and built by the sync.
 */
export const taskTransitionIdempotencyKey = defineMigration({
  name: '2026-10-19-task-transition-idempotency-key',
  description:
    'idempotency_key and idempotency_digest on task_transitions and approval_items, so a retried task transition replays instead of applying twice.',
  isApplied: async (context) => {
    for (const table of TABLES) {
      if (!(await context.tableExists({ table }))) continue;
      for (const { column } of COLUMNS) {
        if (!(await context.columnExists({ table, column }))) return false;
      }
    }
    return true;
  },
  up: async (context) => {
    for (const table of TABLES) {
      if (!(await context.tableExists({ table }))) continue;
      for (const { column, type } of COLUMNS) {
        context.say(`adding ${table}.${column}`);
        await context.addColumnIfMissing({ table, column, type });
      }
    }
  },
});
