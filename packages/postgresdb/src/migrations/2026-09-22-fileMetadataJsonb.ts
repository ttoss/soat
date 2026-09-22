import { defineMigration } from '@ttoss/postgresdb';

/**
 * `files.metadata` holds a caller's annotations as JSONB rather than as the
 * serialized text of the same object, so the column and the wire field agree
 * on one shape. `sync` will not change a column's type, so this is a
 * migration.
 *
 * The conversion is read-neutral, and identical to the one `documents.metadata`
 * went through: a value that parses becomes the value it parsed to, and a value
 * that does not becomes a JSON string of itself — which is the text a read of
 * it already returned. The empty string and the literal `null` become SQL
 * NULL, since both read as an absent bag.
 */
export const fileMetadataJsonb = defineMigration({
  name: '2026-09-22-file-metadata-jsonb',
  description:
    'files.metadata from serialized text to jsonb, so the column and the wire field carry one shape.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'files' }))) return true;

    const [column] = await context.select<{ data_type: string }>({
      sql: `SELECT data_type FROM information_schema.columns
              WHERE table_name = 'files' AND column_name = 'metadata'`,
    });

    return column?.data_type === 'jsonb';
  },
  up: async (context) => {
    context.say('converting files.metadata to jsonb');

    // One multi-statement string: Postgres runs a simple query's statements in
    // a single implicit transaction, so the column is never observed dropped
    // but not replaced. Separate `run` calls would lose that — they can land
    // on different pooled connections.
    //
    // The cast goes through a function rather than a pattern match because no
    // pattern separates valid JSON from text that merely starts like it: a
    // truncated `{"a":` would pass any such test and then raise mid-statement,
    // leaving the whole conversion unrun. `pg_temp` is session-local, so the
    // helper goes away with the connection.
    await context.run({
      sql: `
        CREATE FUNCTION pg_temp.soat_file_text_to_jsonb(value text) RETURNS jsonb AS $fn$
        BEGIN
          RETURN value::jsonb;
        EXCEPTION WHEN others THEN
          RETURN to_jsonb(value);
        END;
        $fn$ LANGUAGE plpgsql IMMUTABLE;

        ALTER TABLE files ADD COLUMN metadata_jsonb jsonb;

        UPDATE files
           SET metadata_jsonb = pg_temp.soat_file_text_to_jsonb(metadata)
         WHERE metadata IS NOT NULL
           AND metadata <> ''
           AND metadata <> 'null';

        ALTER TABLE files DROP COLUMN metadata;
        ALTER TABLE files RENAME COLUMN metadata_jsonb TO metadata;
      `,
    });
  },
});
