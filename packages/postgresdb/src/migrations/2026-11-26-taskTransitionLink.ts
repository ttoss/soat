import { defineMigration } from '@ttoss/postgresdb';

const TABLE = 'task_transitions';
const COLUMN = 'link';

/**
 * The link a history row records. `sync` never alters an existing table, so
 * the column is a migration; rows already written record no link.
 */
export const taskTransitionLink = defineMigration({
  name: '2026-11-26-task-transition-link',
  description:
    'link on task_transitions, the task link a history row records as added or removed.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: TABLE }))) return true;
    return context.columnExists({ table: TABLE, column: COLUMN });
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: TABLE }))) return;
    context.say(`adding ${TABLE}.${COLUMN}`);
    await context.addColumnIfMissing({
      table: TABLE,
      column: COLUMN,
      type: 'json',
    });
  },
});
