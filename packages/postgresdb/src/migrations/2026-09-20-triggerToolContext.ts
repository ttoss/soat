import { defineMigration } from '@ttoss/postgresdb';

/**
 * `triggers.tool_context` carries the caller context a firing forwards to the
 * run it starts, so an agent whose tools authorize through `{{context:<key>}}`
 * can be put on a schedule.
 *
 * `sync` creates missing tables and never alters an existing one, so the column
 * is a migration. Nullable with no default: a trigger written before it exists
 * forwards no context, which is what it did.
 */
export const triggerToolContext = defineMigration({
  name: '2026-09-20-trigger-tool-context',
  description:
    'triggers.tool_context stores the caller context a firing forwards, so a scheduled run can reach a tool that authorizes per call.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'triggers' }))) return true;
    return context.columnExists({ table: 'triggers', column: 'tool_context' });
  },
  up: async (context) => {
    context.say('adding triggers.tool_context');
    await context.addColumnIfMissing({
      table: 'triggers',
      column: 'tool_context',
      type: 'jsonb',
    });
  },
});
