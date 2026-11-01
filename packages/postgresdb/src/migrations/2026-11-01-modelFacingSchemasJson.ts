import type { MigrationContext } from '@ttoss/postgresdb';
import { defineMigration } from '@ttoss/postgresdb';

/**
 * The JSON Schemas a provider receives, stored `json` so a new write keeps
 * its author's key order (`README.md`, "JSON or JSONB"). A row already stored
 * keeps the order `jsonb` gave it.
 */
const COLUMNS = [
  { table: 'agents', column: 'output_schema' },
  { table: 'tools', column: 'parameters' },
] as const;

const jsonbColumns = async (context: MigrationContext) => {
  const rows = await context.select<{ table_name: string }>({
    sql: `SELECT table_name FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND data_type = 'jsonb'
             AND (table_name, column_name) IN (${COLUMNS.map((entry) => {
               return `('${entry.table}', '${entry.column}')`;
             }).join(', ')})`,
  });
  const tables = new Set(
    rows.map((row) => {
      return row.table_name;
    })
  );
  return COLUMNS.filter((entry) => {
    return tables.has(entry.table);
  });
};

export const modelFacingSchemasJson = defineMigration({
  name: '2026-11-01-model-facing-schemas-json',
  description:
    'agents.output_schema and tools.parameters from jsonb to json, so a schema keeps the key order its author wrote.',
  isApplied: async (context) => {
    return (await jsonbColumns(context)).length === 0;
  },
  up: async (context) => {
    for (const entry of await jsonbColumns(context)) {
      context.say(`converting ${entry.table}.${entry.column} to json`);
      await context.run({
        sql: `ALTER TABLE ${entry.table}
                ALTER COLUMN ${entry.column} TYPE json
                USING ${entry.column}::json`,
      });
    }
  },
});
