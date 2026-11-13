import { defineMigration } from '@ttoss/postgresdb';

const ADDED = [
  'generations',
  'orchestration_runs',
  'tasks',
  'playbook_executions',
  'eval_runs',
  'trigger_firings',
];

const DROPPED = [
  { table: 'triggers', column: 'created_by_user_id' },
  { table: 'orchestration_runs', column: 'principal_kind' },
  { table: 'orchestration_runs', column: 'principal_id' },
  { table: 'orchestration_runs', column: 'principal_bound' },
  { table: 'generations', column: 'acted_as_principal_bound' },
];

/**
 * `authority` on every durable row, the stored authority its work runs
 * under. Not backfilled: a row written before it has none, and its work is
 * refused (`WORK_AUTHORITY_MISSING`). The principal columns a drive re-minted
 * a token from, and a trigger's creator, are dropped.
 */
export const workAuthority = defineMigration({
  name: '2026-11-13-work-authority',
  description:
    '`authority` on generations, orchestration_runs, tasks, playbook_executions, eval_runs and trigger_firings; triggers.created_by_user_id, orchestration_runs.principal_* and generations.acted_as_principal_bound dropped.',
  isApplied: async (context) => {
    for (const table of ADDED) {
      if (!(await context.tableExists({ table }))) continue;
      if (!(await context.columnExists({ table, column: 'authority' }))) {
        return false;
      }
    }
    for (const { table, column } of DROPPED) {
      if (!(await context.tableExists({ table }))) continue;
      if (await context.columnExists({ table, column })) return false;
    }
    return true;
  },
  up: async (context) => {
    context.say('adding authority, dropping re-minted principals');
    const statements: string[] = [];
    for (const table of ADDED) {
      if (!(await context.tableExists({ table }))) continue;
      statements.push(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS authority json;`
      );
    }
    for (const { table, column } of DROPPED) {
      if (!(await context.tableExists({ table }))) continue;
      statements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column};`);
    }
    if (statements.length === 0) return;
    await context.run({ sql: statements.join('\n') });
  },
});
