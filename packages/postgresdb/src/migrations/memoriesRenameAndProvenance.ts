import { defineMigration } from '@ttoss/postgresdb';

/**
 * The renames are NOT independent: `memories` and its index names are about to
 * be claimed by the other table, and index names are unique per schema, so the
 * container must vacate them first. The two `source_*` reads must also precede
 * the drops that take those columns away.
 *
 * Public ids are deliberately left alone. Existing containers keep their
 * `mem_…` ids and existing items their `mem_entry_…`; only ids minted after
 * the cutover follow the new prefixes. Rewriting them would break every id a
 * caller has stored.
 *
 * `IF EXISTS` on each index rename covers a database synced before the index
 * was declared: the sync that follows the migrations creates it under the new
 * name either way.
 */
const RENAME_SQL = `
  ALTER TABLE memories RENAME TO memory_stores;
  ALTER INDEX IF EXISTS memories_public_id_unique
    RENAME TO memory_stores_public_id_unique;

  ALTER TABLE memory_entries RENAME TO memories;
  ALTER INDEX IF EXISTS memory_entries_public_id_unique
    RENAME TO memories_public_id_unique;
  ALTER INDEX IF EXISTS memory_entries_embedding_hnsw_idx
    RENAME TO memories_embedding_hnsw_idx;

  ALTER TABLE memories RENAME COLUMN memory_id TO memory_store_id;
  ALTER TABLE memories
    RENAME COLUMN superseded_by_entry_id TO superseded_by_memory_id;

  ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_id varchar(32);

  UPDATE memories
     SET source_id = conversations.public_id
    FROM conversations
   WHERE memories.source_conversation_id = conversations.id;

  UPDATE memories
     SET source_type = CASE
       WHEN source_conversation_id IS NOT NULL THEN 'conversation'
       ELSE 'manual'
     END;

  ALTER TABLE memories DROP COLUMN source_generation_id;
  ALTER TABLE memories DROP COLUMN source_conversation_id;
`;

export const memoriesRenameAndProvenance = defineMigration({
  name: 'memories-rename-and-provenance',
  description:
    'memories -> memory_stores and memory_entries -> memories, with source_conversation_id and source_generation_id collapsed into source_id.',
  /**
   * `sync --alter` cannot do this: it only ever adds, so it would leave both
   * old tables in place and create two empty new ones, stranding every row.
   *
   * The item table is gone is the change itself. A database `sync` has just
   * built never had one, so it records the migration rather than running it.
   */
  isApplied: async (context) => {
    return !(await context.tableExists({ table: 'memory_entries' }));
  },
  up: async (context) => {
    context.say('renaming the memory container and item tables');

    // One multi-statement string on purpose: Postgres runs the commands of a
    // simple query in a single implicit transaction, so a failure can never
    // leave the container renamed and the item not. Separate `run` calls would
    // lose that — they can land on different pooled connections.
    await context.run({ sql: RENAME_SQL });
  },
});
