import { defineMigration } from '@ttoss/postgresdb';

/**
 * `orchestration_node_executions.dispatches` counts every dispatch of one
 * attempt, so a node whose side effect ran more than once under a single key
 * says so on the run's own record.
 *
 * `sync` creates missing tables and never alters one that exists, so the column
 * is a migration. Existing rows are dispatched at least once, which is what the
 * default records.
 */
export const orchestrationNodeExecutionDispatches = defineMigration({
  name: '2026-09-20-orchestration-node-execution-dispatches',
  description:
    'orchestration_node_executions.dispatches counts the dispatches one attempt issued, so a redelivered node execution is visible on the run.',
  isApplied: async (context) => {
    if (
      !(await context.tableExists({ table: 'orchestration_node_executions' }))
    ) {
      return true;
    }
    return context.columnExists({
      table: 'orchestration_node_executions',
      column: 'dispatches',
    });
  },
  up: async (context) => {
    context.say('adding orchestration_node_executions.dispatches');
    await context.addColumnIfMissing({
      table: 'orchestration_node_executions',
      column: 'dispatches',
      type: 'integer NOT NULL DEFAULT 1',
    });
  },
});
