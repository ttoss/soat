import { defineMigration } from '@ttoss/postgresdb';

/**
 * `documents.metadata` holds a caller's annotations as JSONB rather than as
 * the serialized text of the same object.
 *
 * A stringified bag can only be matched as a whole string, so a filter over
 * the fields inside it has nothing to run against; JSONB containment does.
 * `sync` will not change a column's type, so this is a migration.
 *
 * The conversion is read-neutral. A value that parses becomes the value it
 * parsed to, which is what a read of it already returned. A value that does
 * not parse becomes a JSON string of itself, which is also what a read of it
 * already returned — the deserializer fell back to the raw text rather than
 * failing, so a row written by something other than this application still
 * reads the same on both sides of this change.
 *
 * Two texts are normalized to SQL NULL instead: the empty string, which read
 * as an absent bag, and the literal `null`, whose stored JSON null a JSONB
 * read cannot tell from an absent bag anyway.
 */
export const documentMetadataJsonb = defineMigration({
  name: '2026-09-21-document-metadata-jsonb',
  description:
    'documents.metadata from serialized text to jsonb, so a filter can reach the fields inside a caller bag.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'documents' }))) return true;

    const [column] = await context.select<{ data_type: string }>({
      sql: `SELECT data_type FROM information_schema.columns
              WHERE table_name = 'documents' AND column_name = 'metadata'`,
    });

    return column?.data_type === 'jsonb';
  },
  up: async (context) => {
    context.say('converting documents.metadata to jsonb');

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
        CREATE FUNCTION pg_temp.soat_text_to_jsonb(value text) RETURNS jsonb AS $fn$
        BEGIN
          RETURN value::jsonb;
        EXCEPTION WHEN others THEN
          RETURN to_jsonb(value);
        END;
        $fn$ LANGUAGE plpgsql IMMUTABLE;

        ALTER TABLE documents ADD COLUMN metadata_jsonb jsonb;

        UPDATE documents
           SET metadata_jsonb = pg_temp.soat_text_to_jsonb(metadata)
         WHERE metadata IS NOT NULL
           AND metadata <> ''
           AND metadata <> 'null';

        ALTER TABLE documents DROP COLUMN metadata;
        ALTER TABLE documents RENAME COLUMN metadata_jsonb TO metadata;
      `,
    });
  },
});
