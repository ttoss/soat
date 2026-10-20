import { defineMigration } from '@ttoss/postgresdb';

/**
 * `playbook_cases.actor_id`, the end user a case belongs to. `SET NULL` on
 * delete, so a case outlives its actor.
 *
 * One statement string, so the column never lands without its index: the
 * probe reads the column, and a half-applied run would be recorded as done.
 */
const UP_SQL = `
  ALTER TABLE playbook_cases
    ADD COLUMN IF NOT EXISTS actor_id integer
      REFERENCES actors (id) ON DELETE SET NULL ON UPDATE CASCADE;
  CREATE INDEX IF NOT EXISTS playbook_cases_actor_id_idx
    ON playbook_cases (actor_id);
`;

export const playbookCaseActor = defineMigration({
  name: '2026-10-20-playbook-case-actor',
  description: 'playbook_cases.actor_id, the end user a case belongs to.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'playbook_cases' }))) return true;
    return context.columnExists({
      table: 'playbook_cases',
      column: 'actor_id',
    });
  },
  up: async (context) => {
    context.say('adding playbook_cases.actor_id');
    await context.run({ sql: UP_SQL });
  },
});
