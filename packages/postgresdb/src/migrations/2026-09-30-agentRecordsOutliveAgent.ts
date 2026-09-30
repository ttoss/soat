import { defineMigration } from '@ttoss/postgresdb';

const TABLES = ['generations', 'traces', 'sessions'] as const;

/**
 * `agent_id` on generations, traces and sessions becomes nullable and
 * `SET NULL` on delete, with the agent's public id kept beside it: a shared
 * agent's records belong to the project it ran in, so deleting the agent in
 * its own project must not take another project's rows with it.
 *
 * One statement string per table, so its constraint, column and backfill land
 * together: the probe reads the column. Each is idempotent, so a run that
 * stopped between tables is finished by the next. A table without `agent_id`
 * predates the column and is left alone.
 */
const tableSql = (table: (typeof TABLES)[number]): string => {
  return `
  DO $$
  DECLARE fk record;
  BEGIN
    FOR fk IN
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_name = tc.table_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = '${table}'
        AND kcu.column_name = 'agent_id'
    LOOP
      EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', fk.constraint_name);
    END LOOP;
  END $$;
  ALTER TABLE ${table}
    ALTER COLUMN agent_id DROP NOT NULL,
    ADD CONSTRAINT ${table}_agent_id_fkey FOREIGN KEY (agent_id)
      REFERENCES agents (id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS agent_public_id varchar(32);
  UPDATE ${table} t SET agent_public_id = a.public_id
    FROM agents a
    WHERE a.id = t.agent_id AND t.agent_public_id IS NULL;
  ALTER TABLE ${table} ALTER COLUMN agent_public_id SET NOT NULL;
`;
};

const tablesToChange = async (context: {
  columnExists: (args: { table: string; column: string }) => Promise<boolean>;
}): Promise<Array<(typeof TABLES)[number]>> => {
  const present: Array<(typeof TABLES)[number]> = [];
  for (const table of TABLES) {
    if (await context.columnExists({ table, column: 'agent_id' })) {
      present.push(table);
    }
  }
  return present;
};

export const agentRecordsOutliveAgent = defineMigration({
  name: '2026-09-30-agent-records-outlive-agent',
  description:
    'generations, traces and sessions keep the agent public id and survive the agent being deleted.',
  isApplied: async (context) => {
    for (const table of await tablesToChange(context)) {
      if (!(await context.columnExists({ table, column: 'agent_public_id' }))) {
        return false;
      }
    }
    return true;
  },
  up: async (context) => {
    for (const table of await tablesToChange(context)) {
      context.say(`keeping agent public ids on ${table}`);
      await context.run({ sql: tableSql(table) });
    }
  },
});
