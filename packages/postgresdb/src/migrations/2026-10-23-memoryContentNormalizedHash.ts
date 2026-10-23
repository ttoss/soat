import { defineMigration } from '@ttoss/postgresdb';

import { hashNormalizedMemoryContent } from '../utils/memoryContentHash';

type ContentRow = { id: number; content: string };

/**
 * One statement string, so the column never lands without its values, its
 * `NOT NULL` or its index. The backfill is computed here because Postgres
 * regex has no `\p{P}`.
 */
const upSql = (rows: ContentRow[]) => {
  // Integers and hex digests only, computed above: nothing caller-written.
  const backfill =
    rows.length === 0
      ? ''
      : `UPDATE memory_contents AS c
            SET normalized_hash = v.hash
           FROM (VALUES ${rows
             .map((row) => {
               return `(${row.id}, '${hashNormalizedMemoryContent(row)}')`;
             })
             .join(',\n')}) AS v (id, hash)
          WHERE c.id = v.id;`;

  return `
    ALTER TABLE memory_contents
      ADD COLUMN IF NOT EXISTS normalized_hash varchar(64);
    ${backfill}
    ALTER TABLE memory_contents ALTER COLUMN normalized_hash SET NOT NULL;
    CREATE INDEX IF NOT EXISTS memory_contents_store_normalized_hash_idx
      ON memory_contents (memory_store_id, normalized_hash);
  `;
};

export const memoryContentNormalizedHash = defineMigration({
  name: '2026-10-23-memory-content-normalized-hash',
  description:
    'memory_contents.normalized_hash, the case- and punctuation-insensitive ' +
    'key spellings of one text share, backfilled and indexed per store.',
  // A missing table is not applied: an earlier migration may yet create it
  // without the column.
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'memory_contents' })))
      return false;
    return context.columnExists({
      table: 'memory_contents',
      column: 'normalized_hash',
    });
  },
  up: async (context) => {
    if (!(await context.tableExists({ table: 'memory_contents' }))) return;
    const rows = await context.select<ContentRow>({
      sql: 'SELECT id, content FROM memory_contents',
    });
    context.say(`backfilling ${rows.length} memory_contents.normalized_hash`);
    await context.run({ sql: upSql(rows) });
  },
});
