import { defineMigration } from '@ttoss/postgresdb';

const COLUMNS = ['from_workflow_version', 'to_workflow_version'];

/**
 * `task_transitions.from_workflow_version` and `to_workflow_version`, the two
 * versions a migration history row moves a task between. `sync` never alters
 * an existing table, so the columns are a migration.
 */
export const taskTransitionWorkflowVersions = defineMigration({
  name: '2026-10-19-task-transition-workflow-versions',
  description:
    'from_workflow_version and to_workflow_version on task_transitions, the versions a task migration moves a task between.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'task_transitions' }))) {
      return true;
    }
    for (const column of COLUMNS) {
      if (
        !(await context.columnExists({ table: 'task_transitions', column }))
      ) {
        return false;
      }
    }
    return true;
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: 'task_transitions' }))) return;
    for (const column of COLUMNS) {
      context.say(`adding task_transitions.${column}`);
      await context.addColumnIfMissing({
        table: 'task_transitions',
        column,
        type: 'integer',
      });
    }
  },
});
