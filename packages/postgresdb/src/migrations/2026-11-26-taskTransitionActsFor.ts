import { defineMigration } from '@ttoss/postgresdb';

const TABLE = 'task_transitions';

const COLUMNS = ['acts_for_type', 'acts_for_id'];

/**
 * Whom a history row's principal moved the task for. `sync` never alters an
 * existing table, so the columns are a migration; rows already written name
 * no one.
 */
export const taskTransitionActsFor = defineMigration({
  name: '2026-11-26-task-transition-acts-for',
  description:
    'acts_for_type and acts_for_id on task_transitions, the principal an IAM token or On-Behalf-Of assertion named for the move.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: TABLE }))) return true;
    for (const column of COLUMNS) {
      if (!(await context.columnExists({ table: TABLE, column }))) return false;
    }
    return true;
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: TABLE }))) return;
    for (const column of COLUMNS) {
      context.say(`adding ${TABLE}.${column}`);
      await context.addColumnIfMissing({
        table: TABLE,
        column,
        type: 'varchar(255)',
      });
    }
  },
});
