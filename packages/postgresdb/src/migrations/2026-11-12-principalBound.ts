import { defineMigration } from '@ttoss/postgresdb';

const COLUMNS = [
  {
    table: 'generations',
    column: 'acted_as_principal_bound',
    principal: 'acted_as_principal_id',
  },
  {
    table: 'orchestration_runs',
    column: 'principal_bound',
    principal: 'principal_id',
  },
  {
    table: 'playbook_versions',
    column: 'principal_bound',
    principal: 'principal_id',
  },
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
    for (const { table, column, principal } of COLUMNS) {
      if (!(await context.tableExists({ table }))) continue;
      if (await context.columnExists({ table, column })) continue;
      // Later migrations drop the column: `2026-11-13-work-authority` for
      // `authority`, `2026-11-14-resource-grants` with the principal it sat beside.
      if (await context.columnExists({ table, column: 'authority' })) continue;
      if (await context.columnExists({ table, column: principal })) {
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
