import { defineMigration } from '@ttoss/postgresdb';

/** Each table's acts_for column prefixes, one per principal it names. */
const PREFIXES: Record<string, string[]> = {
  agent_versions: ['created_by_'],
  approval_items: ['resolved_by_'],
  audit_entries: [''],
  decider_versions: ['created_by_'],
  document_versions: ['created_by_'],
  eval_results: ['labeled_by_'],
  exception_items: ['acknowledged_by_', 'resolved_by_'],
  generations: ['content_redacted_by_'],
  guardrail_versions: ['created_by_'],
  memory_assertions: [''],
  orchestration_versions: ['created_by_'],
  playbook_entries: ['created_by_'],
  playbook_executions: ['created_by_'],
  playbook_exports: ['created_by_'],
  playbook_upgrades: ['created_by_'],
  playbook_versions: ['created_by_'],
  task_dependencies: ['created_by_'],
  traces: ['content_redacted_by_'],
  workflow_migrations: ['created_by_'],
  workflow_versions: ['created_by_'],
};

const COLUMNS = Object.entries(PREFIXES).flatMap(([table, prefixes]) => {
  return prefixes.flatMap((prefix) => {
    return [`${prefix}acts_for_type`, `${prefix}acts_for_id`].map((column) => {
      return { table, column };
    });
  });
});

/**
 * Whom each record's principal acted for. `sync` never alters an existing
 * table, so the columns are a migration; rows already written name no one.
 */
export const recordActsFor = defineMigration({
  name: '2026-11-26-record-acts-for',
  description:
    'acts_for_type and acts_for_id beside every principal a record names: the principal an IAM token or On-Behalf-Of assertion acted for.',
  isApplied: async (context) => {
    for (const { table, column } of COLUMNS) {
      if (!(await context.tableExists({ table }))) continue;
      if (!(await context.columnExists({ table, column }))) return false;
    }
    return true;
  },
  up: async (context) => {
    for (const { table, column } of COLUMNS) {
      if (!(await context.tableExists({ table }))) continue;
      context.say(`adding ${table}.${column}`);
      await context.addColumnIfMissing({
        table,
        column,
        type: 'varchar(255)',
      });
    }
  },
});
