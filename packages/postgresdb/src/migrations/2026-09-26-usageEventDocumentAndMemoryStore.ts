import { defineMigration } from '@ttoss/postgresdb';

/**
 * `usage_events.document_id` and `usage_events.memory_store_id`: what an
 * embedding event embedded. Both `SET NULL` on delete, like every attribution
 * column, so spend outlives the document or store.
 *
 * No backfill: an existing embedding event's idempotency key is a bare uuid,
 * so nothing on the row records what it embedded.
 *
 * One statement string, so the columns never land without their indexes: the
 * probe reads the columns, and a half-applied run would be recorded as done.
 */
const UP_SQL = `
  ALTER TABLE usage_events
    ADD COLUMN IF NOT EXISTS document_id integer
      REFERENCES documents (id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN IF NOT EXISTS memory_store_id integer
      REFERENCES memory_stores (id) ON DELETE SET NULL ON UPDATE CASCADE;
  CREATE INDEX IF NOT EXISTS usage_events_document_id_idx
    ON usage_events (document_id);
  CREATE INDEX IF NOT EXISTS usage_events_memory_store_id_idx
    ON usage_events (memory_store_id);
`;

export const usageEventDocumentAndMemoryStore = defineMigration({
  name: '2026-09-26-usage-event-document-and-memory-store',
  description:
    'usage_events.document_id and usage_events.memory_store_id, what an embedding event embedded.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'usage_events' }))) return true;
    return (
      (await context.columnExists({
        table: 'usage_events',
        column: 'document_id',
      })) &&
      (await context.columnExists({
        table: 'usage_events',
        column: 'memory_store_id',
      }))
    );
  },
  up: async (context) => {
    context.say('adding usage_events.document_id and memory_store_id');
    await context.run({ sql: UP_SQL });
  },
});
