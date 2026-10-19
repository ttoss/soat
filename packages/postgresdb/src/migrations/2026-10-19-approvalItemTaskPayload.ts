import { defineMigration } from '@ttoss/postgresdb';

/**
 * `approval_items.task_payload`, the payload a parked task transition carries
 * until its approval fires it. `sync` never alters an existing table, so the
 * column is a migration.
 */
export const approvalItemTaskPayload = defineMigration({
  name: '2026-10-19-approval-item-task-payload',
  description:
    'approval_items.task_payload, the payload a parked task transition applies when its approval fires it.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'approval_items' }))) return true;
    return context.columnExists({
      table: 'approval_items',
      column: 'task_payload',
    });
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: 'approval_items' }))) return;
    context.say('adding approval_items.task_payload');
    await context.addColumnIfMissing({
      table: 'approval_items',
      column: 'task_payload',
      type: 'jsonb',
    });
  },
});
