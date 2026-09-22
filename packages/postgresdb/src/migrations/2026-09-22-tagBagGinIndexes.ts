import { defineMigration } from '@ttoss/postgresdb';

/**
 * A GIN index over every `tags` column, so a tag match is a lookup rather than
 * a scan.
 *
 * Containment is the only way a tag bag is read — the `?tags=` list filter,
 * knowledge search and a `soat:ResourceTag/<key>` policy condition all match
 * it with `@>` — and without an index each of those reads every row the rest
 * of the query leaves in scope. The cost then grows with the project rather
 * than with the answer, and it grows quietly: a filter that is fast and a
 * filter that is slow return the same rows.
 *
 * `jsonb_path_ops` rather than the default operator class: it indexes whole
 * key/value paths instead of each key and each value separately, which is the
 * question `@>` asks, and it makes the smaller index for it.
 *
 * `sync` builds these from the models on a database that has no tables yet, so
 * this migration exists for one that already holds them.
 */
const TAGGED_TABLES = [
  'actors',
  'conversations',
  'documents',
  'files',
  'memories',
  'memory_stores',
  'sessions',
] as const;

const indexNameFor = (table: string) => {
  return `${table}_tags_gin_idx`;
};

type Context = {
  select: <T extends object>(args: { sql: string }) => Promise<T[]>;
};

/**
 * The tables in this database holding a `tags` column, and whether each one is
 * JSONB already.
 *
 * A table existing is not enough to index: the operator class is a JSONB one,
 * so a column of any other type cannot carry the index yet. But it is enough
 * to say the work is outstanding — every probe runs before any `up`, so a
 * database still holding `text[]` tags is one the earlier conversion has not
 * reached rather than one with nothing to do. Reading only JSONB here would
 * report this migration done and then never build anything.
 *
 * A table with no `tags` column at all is neither: `sync` adds the column and
 * its index together from the model, which is what reaches those databases.
 */
const tagColumns = async (
  context: Context
): Promise<Map<string, { jsonb: boolean }>> => {
  const columns = await context.select<{
    table_name: string;
    data_type: string;
  }>({
    sql: `SELECT table_name, data_type FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND column_name = 'tags'`,
  });

  return new Map(
    columns.map((column) => {
      return [column.table_name, { jsonb: column.data_type === 'jsonb' }];
    })
  );
};

export const tagBagGinIndexes = defineMigration({
  name: '2026-09-22-tag-bag-gin-indexes',
  description:
    'A GIN index with jsonb_path_ops over every tags column, so containment is a lookup rather than a scan.',
  isApplied: async (context) => {
    const tagged = await tagColumns(context);

    const built = await context.select<{ indexname: string }>({
      sql: `SELECT indexname FROM pg_indexes
              WHERE schemaname = current_schema()
                AND indexname LIKE '%_tags_gin_idx'`,
    });

    const names = new Set(
      built.map((index) => {
        return index.indexname;
      })
    );

    return TAGGED_TABLES.every((table) => {
      return !tagged.has(table) || names.has(indexNameFor(table));
    });
  },
  up: async (context) => {
    const tagged = await tagColumns(context);

    for (const table of TAGGED_TABLES) {
      if (!tagged.get(table)?.jsonb) continue;

      context.say(`indexing ${table}.tags`);

      // Not `CONCURRENTLY`: it cannot run inside a transaction block, and the
      // runner is what decides the transaction. A plain build holds a lock
      // that blocks writes to the table and lets reads through, for as long as
      // one pass over the rows takes.
      //
      // `IF NOT EXISTS` so a retry after a failure part-way through the list
      // skips what the previous attempt finished: the ledger records only a
      // migration that ran to the end.
      await context.run({
        sql: `CREATE INDEX IF NOT EXISTS ${indexNameFor(table)}
                ON ${table} USING gin (tags jsonb_path_ops)`,
      });
    }
  },
});
