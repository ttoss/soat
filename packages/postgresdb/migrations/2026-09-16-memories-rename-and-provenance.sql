-- Memories rename + provenance simplification (#1318).
--
--   container: `memories`       -> `memory_stores`   (public id `mstore_…`)
--   item:      `memory_entries` -> `memories`        (public id `mem_…`)
--
-- `sync --alter` CANNOT perform this change: it only ever adds. It would leave
-- both old tables in place and create two empty new ones, stranding every row.
-- Run this by hand, before deploying the release that carries the new models.
--
-- The two renames are NOT independent — `memories` and its index names are
-- about to be claimed by the other table, and index names are unique per
-- schema — so the container must vacate them first. Steps 4 and 5 read
-- `source_conversation_id`, so step 6 cannot move ahead of them.
--
-- Public ids are NOT rewritten. Existing containers keep their `mem_…` ids and
-- existing items keep `mem_entry_…`; only ids minted after the cutover follow
-- the new prefixes. Rewriting them would break every id a caller has stored.

BEGIN;

-- 1. Container vacates the `memories` name.
ALTER TABLE memories RENAME TO memory_stores;
ALTER INDEX memories_public_id_unique RENAME TO memory_stores_public_id_unique;

-- 2. Item takes it.
ALTER TABLE memory_entries RENAME TO memories;
ALTER INDEX memory_entries_public_id_unique RENAME TO memories_public_id_unique;
ALTER INDEX memory_entries_embedding_hnsw_idx RENAME TO memories_embedding_hnsw_idx;

-- 3. Columns that named the old concepts.
ALTER TABLE memories RENAME COLUMN memory_id TO memory_store_id;
ALTER TABLE memories RENAME COLUMN superseded_by_entry_id TO superseded_by_memory_id;

-- 4. `source_id` replaces the conversation foreign key, holding the
--    conversation's PUBLIC id so the column can name other source kinds later.
ALTER TABLE memories ADD COLUMN source_id varchar(32);

UPDATE memories
SET source_id = conversations.public_id
FROM conversations
WHERE memories.source_conversation_id = conversations.id;

-- 5. Collapse the enum to `manual | conversation`. `agent`, `extraction` and
--    `orchestration` described the write MECHANISM; the column now describes
--    only whether there is a source to point at. A row that came from a
--    conversation turn says so, everything else is `manual` — including agent
--    writes whose generation is no longer recorded.
UPDATE memories
SET source_type = CASE
  WHEN source_conversation_id IS NOT NULL THEN 'conversation'
  ELSE 'manual'
END;

-- 6. The foreign keys the new model no longer carries. Dropping the columns
--    takes their FK constraints with them.
ALTER TABLE memories DROP COLUMN source_generation_id;
ALTER TABLE memories DROP COLUMN source_conversation_id;

COMMIT;

-- Follow-up, per the index-rename rule in this package's README: the surviving
-- foreign-key CONSTRAINT names still read `memory_entries_…` / `memories_…`
-- from before the rename. Postgres keeps them through `ALTER TABLE … RENAME`
-- and Sequelize matches foreign keys by column, not by name, so they are
-- cosmetic. Rename them if you want the catalog to read cleanly:
--
--   ALTER TABLE memories RENAME CONSTRAINT memory_entries_memory_id_fkey
--     TO memories_memory_store_id_fkey;
--   ALTER TABLE memories RENAME CONSTRAINT memory_entries_superseded_by_entry_id_fkey
--     TO memories_superseded_by_memory_id_fkey;
