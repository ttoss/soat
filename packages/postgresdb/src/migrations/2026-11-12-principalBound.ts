import { defineMigration } from '@ttoss/postgresdb';

const COLUMNS = [
  { table: 'generations', column: 'acted_as_principal_bound' },
  { table: 'orchestration_runs', column: 'principal_bound' },
  { table: 'playbook_versions', column: 'principal_bound' },
];

/**
 * The IAM token bound beside each stored principal a background drive re-mints
 * a credential from. Nullable and not backfilled: no stored principal acted
 * under a token.
 */
export const principalBound = defineMigration({
  name: '2026-11-12-principal-bound',
  description:
    'generations.acted_as_principal_bound, orchestration_runs.principal_bound and playbook_versions.principal_bound.',
  isApplied: async (context) => {
    for (const { table, column } of COLUMNS) {
      if (!(await context.tableExists({ table }))) continue;
      if (await context.columnExists({ table, column })) continue;
      // `2026-11-13-work-authority` drops the column for `authority`.
      if (!(await context.columnExists({ table, column: 'authority' }))) {
        return false;
      }
    }
    return true;
  },
  up: async (context) => {
    context.say('adding the principal bound columns');
    const statements: string[] = [];
    for (const { table, column } of COLUMNS) {
      if (!(await context.tableExists({ table }))) continue;
      statements.push(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} json;`
      );
    }
    if (statements.length === 0) return;
    await context.run({ sql: statements.join('\n') });
  },
});
