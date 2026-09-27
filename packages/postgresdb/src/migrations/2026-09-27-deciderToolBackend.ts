import { defineMigration } from '@ttoss/postgresdb';

/**
 * `deciders.tool_id`, the tool backend, beside an `agent_id` that is now one of
 * two backends and so nullable. `RESTRICT`, like `agent_id`: deleting the tool
 * would otherwise take the decider and its readable criteria with it.
 *
 * `sync({ alter: true })` never emits `DROP NOT NULL` on a foreign-key column,
 * so the relaxation reaches a database only through here. One statement string,
 * so the column never lands without its index.
 */
const UP_SQL = `
  ALTER TABLE deciders
    ALTER COLUMN agent_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS tool_id integer
      REFERENCES tools (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  CREATE INDEX IF NOT EXISTS deciders_tool_id_idx ON deciders (tool_id);
`;

const AGENT_ID_NOT_NULL_SQL = `
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'deciders'
     AND column_name = 'agent_id' AND is_nullable = 'NO'
`;

export const deciderToolBackend = defineMigration({
  name: '2026-09-27-decider-tool-backend',
  description:
    'deciders.tool_id, the tool backend, and deciders.agent_id nullable.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'deciders' }))) return true;
    const held = await context.select({ sql: AGENT_ID_NOT_NULL_SQL });
    return (
      held.length === 0 &&
      (await context.columnExists({ table: 'deciders', column: 'tool_id' }))
    );
  },
  up: async (context) => {
    context.say(
      'adding deciders.tool_id and making deciders.agent_id nullable'
    );
    await context.run({ sql: UP_SQL });
  },
});
