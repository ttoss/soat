import { defineMigration } from '@ttoss/postgresdb';

/**
 * `memories.actor_id`, the end user a memory belongs to. `SET NULL` on delete,
 * so a memory outlives its actor.
 *
 * One statement string, so the column never lands without its index: the
 * probe reads the column, and a half-applied run would be recorded as done.
 */
const UP_SQL = `
  ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS actor_id integer
      REFERENCES actors (id) ON DELETE SET NULL ON UPDATE CASCADE;
  CREATE INDEX IF NOT EXISTS memories_memory_store_id_actor_id_idx
    ON memories (memory_store_id, actor_id);
`;

export const memoryActor = defineMigration({
  name: '2026-11-12-memory-actor',
  description: 'memories.actor_id, the end user a memory belongs to.',
  isApplied: async (context) => {
    // Without either table there is nothing to alter: the sync creates both.
    if (!(await context.tableExists({ table: 'memories' }))) return true;
    if (!(await context.tableExists({ table: 'actors' }))) return true;
    return context.columnExists({ table: 'memories', column: 'actor_id' });
  },
  up: async (context) => {
    context.say('adding memories.actor_id');
    await context.run({ sql: UP_SQL });
  },
});
