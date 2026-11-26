import { defineMigration } from '@ttoss/postgresdb';

import { lexicalContentIndex } from '../utils/lexicalIndex';

/**
 * The lexical GIN index on every table knowledge search matches by text, so a
 * lexical search is an index lookup rather than a re-tokenizing scan of every
 * row. `sync` builds it on a database that has no tables yet; this migration
 * reaches one that already holds them.
 */
const LEXICALLY_SEARCHED_TABLES = ['document_chunks', 'memory_contents'];

/**
 * Tables an earlier migration creates without the index. The runner probes
 * every pending migration before running any, so one of these missing now
 * still needs this migration once that one has run.
 */
const CREATED_BY_EARLIER_MIGRATION = new Set(['memory_contents']);

type Context = {
  columnExists: (args: { table: string; column: string }) => Promise<boolean>;
};

const indexable = async (args: { context: Context; table: string }) => {
  return args.context.columnExists({ table: args.table, column: 'content' });
};

export const lexicalGinIndexes = defineMigration({
  name: '2026-11-26-lexical-gin-indexes',
  description:
    'A partial GIN index over to_tsvector(content) on document_chunks and memory_contents, for the lexical half of knowledge search.',
  isApplied: async (context) => {
    const built = await context.select<{ indexname: string }>({
      sql: `SELECT indexname FROM pg_indexes
              WHERE schemaname = current_schema()
                AND indexname LIKE '%_content_lexical_gin_idx'`,
    });
    const names = new Set(
      built.map((index) => {
        return index.indexname;
      })
    );
    for (const table of LEXICALLY_SEARCHED_TABLES) {
      if (!(await indexable({ context, table }))) {
        if (CREATED_BY_EARLIER_MIGRATION.has(table)) return false;
        continue;
      }
      if (!names.has(lexicalContentIndex({ table }).name)) return false;
    }
    return true;
  },
  up: async (context) => {
    for (const table of LEXICALLY_SEARCHED_TABLES) {
      if (!(await indexable({ context, table }))) continue;
      const index = lexicalContentIndex({ table });
      context.say(`indexing ${table}.content`);
      // Not `CONCURRENTLY`: it cannot run inside the runner's transaction
      // block. The build blocks writes to the table, not reads.
      await context.run({
        sql: `CREATE INDEX IF NOT EXISTS ${index.name}
                ON ${table} USING gin (${index.fields[0].val})
                WHERE ${index.where.val}`,
      });
    }
  },
});
