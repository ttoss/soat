import { defineMigration } from '@ttoss/postgresdb';

/**
 * `(project_id, <sort key>, public_id)` on the lists that grow without bound,
 * so a keyset page is an index range scan: the cursor carries the sort key and
 * the `public_id` tiebreak, and these are the columns its `WHERE` and
 * `ORDER BY` read.
 *
 * Not `CONCURRENTLY`: it cannot run inside the runner's transaction block.
 */
const LIST_INDEXES = [
  { table: 'generations', sortKey: 'started_at' },
  { table: 'traces', sortKey: 'created_at' },
  { table: 'audit_entries', sortKey: 'created_at' },
  { table: 'usage_events', sortKey: 'created_at' },
] as const;

const indexName = (index: (typeof LIST_INDEXES)[number]) => {
  return `${index.table}_project_id_${index.sortKey}_public_id_idx`;
};

export const listKeysetIndexes = defineMigration({
  name: '2026-10-23-list-keyset-indexes',
  description:
    'A (project_id, sort key, public_id) index on generations, traces, audit_entries and usage_events, for keyset list pages.',
  isApplied: async (context) => {
    const built = await context.select<{ indexname: string }>({
      sql: `SELECT indexname FROM pg_indexes
              WHERE schemaname = current_schema()`,
    });
    const names = new Set(
      built.map((index) => {
        return index.indexname;
      })
    );
    for (const index of LIST_INDEXES) {
      if (!(await context.tableExists({ table: index.table }))) continue;
      if (!names.has(indexName(index))) return false;
    }
    return true;
  },
  up: async (context) => {
    for (const index of LIST_INDEXES) {
      if (!(await context.tableExists({ table: index.table }))) continue;
      context.say(`indexing ${index.table}`);
      await context.run({
        sql: `CREATE INDEX IF NOT EXISTS ${indexName(index)}
                ON ${index.table} (project_id, ${index.sortKey}, public_id)`,
      });
    }
  },
});
