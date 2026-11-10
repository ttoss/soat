import { defineMigration } from '@ttoss/postgresdb';

/**
 * `policies.project_id`, the project a policy belongs to. Nullable, no
 * backfill: every existing policy stays global. `CASCADE`, so a project's
 * policies go with it.
 *
 * One statement string, so the column never lands without its index: the
 * probe reads the column, and a half-applied run would be recorded as done.
 */
const UP_SQL = `
  ALTER TABLE policies
    ADD COLUMN IF NOT EXISTS project_id integer
      REFERENCES projects (id) ON DELETE CASCADE ON UPDATE CASCADE;
  CREATE INDEX IF NOT EXISTS policies_project_id_idx
    ON policies (project_id);
`;

export const policyProjectId = defineMigration({
  name: '2026-11-10-policy-project-id',
  description: 'policies.project_id, the project a policy belongs to.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'policies' }))) return true;
    return context.columnExists({ table: 'policies', column: 'project_id' });
  },
  up: async (context) => {
    context.say('adding policies.project_id');
    await context.run({ sql: UP_SQL });
  },
});
