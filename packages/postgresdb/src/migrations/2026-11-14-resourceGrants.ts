import { defineMigration } from '@ttoss/postgresdb';

const ADDED = [
  'evals',
  'deciders',
  'ingestion_rules',
  'memory_rules',
  'playbooks',
];

const DROPPED = ['principal_kind', 'principal_id', 'principal_bound'].map(
  (column) => {
    return { table: 'playbook_versions', column };
  }
);

/**
 * `policy_ids` on evals, deciders, ingestion rules, memory rules and
 * playbooks, the grant their work runs under. Not backfilled: a row without
 * one grants nothing until a write gives it one. A playbook version's author
 * columns are dropped.
 */
export const resourceGrants = defineMigration({
  name: '2026-11-14-resource-grants',
  description:
    '`policy_ids` (jsonb) on evals, deciders, ingestion_rules, memory_rules and playbooks; playbook_versions.principal_kind/_id/_bound dropped.',
  isApplied: async (context) => {
    for (const table of ADDED) {
      if (!(await context.tableExists({ table }))) continue;
      if (!(await context.columnExists({ table, column: 'policy_ids' }))) {
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
    context.say('adding policy_ids, dropping playbook version authors');
    const statements: string[] = [];
    for (const table of ADDED) {
      if (!(await context.tableExists({ table }))) continue;
      statements.push(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS policy_ids jsonb;`
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
