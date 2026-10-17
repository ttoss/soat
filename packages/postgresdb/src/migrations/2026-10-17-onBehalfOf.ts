import { defineMigration } from '@ttoss/postgresdb';

const TABLES = [
  'playbook_entries',
  'playbook_executions',
  'playbook_upgrades',
  'playbook_exports',
  'audit_entries',
];

/**
 * `on_behalf_of` beside the principal of every playbook case record and audit
 * entry: the tool call a write was made for. Not backfilled.
 *
 * `sync` never alters an existing table, so the columns are a migration.
 */
export const onBehalfOf = defineMigration({
  name: '2026-10-17-on-behalf-of',
  description:
    'on_behalf_of on playbook_entries, playbook_executions, playbook_upgrades, playbook_exports and audit_entries.',
  isApplied: async (context) => {
    for (const table of TABLES) {
      if (!(await context.tableExists({ table }))) continue;
      if (!(await context.columnExists({ table, column: 'on_behalf_of' }))) {
        return false;
      }
    }
    return true;
  },
  up: async (context) => {
    for (const table of TABLES) {
      if (!(await context.tableExists({ table }))) continue;
      context.say(`adding ${table}.on_behalf_of`);
      await context.addColumnIfMissing({
        table,
        column: 'on_behalf_of',
        type: 'jsonb',
      });
    }
  },
});
