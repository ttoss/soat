import type { MigrationContext } from '@ttoss/postgresdb';
import { defineMigration } from '@ttoss/postgresdb';

/**
 * The two tables that carried a `text[]` tags column, under the names they had
 * before `2026-09-16-memories-rename-and-provenance` renamed both. It runs
 * first, so it always meets that vocabulary.
 */
const TAGGED_TABLES = ['memories', 'memory_entries'] as const;

const tableList = TAGGED_TABLES.map((table) => {
  return `'${table}'`;
}).join(', ');

/**
 * The tables still holding the old `text[]` column — the work left to do, and
 * the probe in one query. Both names are module constants, so they are inlined
 * rather than bound.
 */
const unconvertedTables = async (
  context: MigrationContext
): Promise<string[]> => {
  const rows = await context.select<{ table_name: string }>({
    sql: `SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name IN (${tableList})
             AND column_name = 'tags'
             AND data_type = 'ARRAY'
           ORDER BY table_name`,
  });

  return rows.map((row) => {
    return row.table_name;
  });
};

/**
 * Applied per element of the old array:
 *
 *   'role:manager'  -> {"role": "manager"}   (split on the FIRST colon, so a
 *                                             value keeps its own)
 *   'customer'      -> {"customer": ""}      (a bare label has no value)
 *   duplicate keys  -> last element wins
 *   NULL stays NULL; an empty array becomes {}
 */
const convert = (table: string) => {
  return `
    ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tags_jsonb jsonb;

    UPDATE ${table} SET tags_jsonb = (
      SELECT COALESCE(
        jsonb_object_agg(
          split_part(tag, ':', 1),
          CASE
            WHEN position(':' in tag) > 0
              THEN substring(tag from position(':' in tag) + 1)
            ELSE ''
          END
        ),
        '{}'::jsonb
      )
      FROM unnest(${table}.tags) AS tag
    )
    WHERE ${table}.tags IS NOT NULL;

    ALTER TABLE ${table} DROP COLUMN tags;
    ALTER TABLE ${table} RENAME COLUMN tags_jsonb TO tags;
  `;
};

export const memoryTagsToJsonb = defineMigration({
  name: '2026-09-11-memory-tags-to-jsonb',
  description:
    'Memory tags from text[] to key-value jsonb, aligning them with every other tagged resource.',
  /**
   * `sync --alter` cannot do this: Postgres refuses to cast `text[]` to
   * `jsonb`, and a `USING` expression may not contain the per-row subquery the
   * conversion needs.
   *
   * No `text[]` tags column left is the change itself, so a database `sync`
   * has just built and one that converted before the ledger existed both
   * record the migration instead of running it.
   */
  isApplied: async (context) => {
    return (await unconvertedTables(context)).length === 0;
  },
  up: async (context) => {
    for (const table of await unconvertedTables(context)) {
      context.say(`converting ${table}.tags`);

      // One multi-statement string on purpose: Postgres runs the commands of a
      // simple query in a single implicit transaction, so the column is never
      // observed dropped-but-not-replaced. Separate `run` calls would lose
      // that — they can land on different pooled connections.
      await context.run({ sql: convert(table) });
    }
  },
});
