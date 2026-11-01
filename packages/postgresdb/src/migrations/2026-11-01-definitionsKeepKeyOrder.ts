import { defineMigration } from '@ttoss/postgresdb';

/**
 * Resource definitions and the version configs a restore replays, from `jsonb`
 * to `json`, so a later write keeps the key order its author wrote. A stored
 * value keeps the order `jsonb` already gave it. `sync` will not change a
 * column's type, so this is a migration.
 */
const COLUMNS: Record<string, string[]> = {
  agents: [
    'tool_bindings',
    'tool_choice',
    'stop_conditions',
    'active_tool_ids',
    'step_rules',
    'boundary_policy',
    'reasoning',
    'knowledge_config',
    'prompt_caching',
    'guardrail_ids',
  ],
  agent_versions: ['config'],
  guardrails: ['document'],
  guardrail_versions: ['config'],
  orchestrations: [
    'nodes',
    'edges',
    'state_schema',
    'input_schema',
    'output_mapping',
  ],
  orchestration_versions: ['config'],
  workflows: ['states', 'transitions', 'payload_schema'],
  workflow_versions: ['config'],
};

type Column = { table: string; column: string; default: string | null };

/** The listed columns still `jsonb`; one `sync` has not created is absent. */
const pending = async (context: {
  select: <T>(args: { sql: string }) => Promise<T[]>;
}): Promise<Column[]> => {
  const pairs = Object.entries(COLUMNS).flatMap(([table, columns]) => {
    return columns.map((column) => {
      return `('${table}', '${column}')`;
    });
  });
  const rows = await context.select<{
    table_name: string;
    column_name: string;
    column_default: string | null;
  }>({
    sql: `SELECT table_name, column_name, column_default
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND data_type = 'jsonb'
             AND (table_name, column_name) IN (${pairs.join(', ')})`,
  });
  return rows.map((row) => {
    return {
      table: row.table_name,
      column: row.column_name,
      default: row.column_default,
    };
  });
};

/** A `jsonb` default does not convert with the column, so it is re-cast. */
const alterColumn = (column: Column): string => {
  const alter = `ALTER TABLE ${column.table} ALTER COLUMN ${column.column}`;
  return [
    `${alter} DROP DEFAULT;`,
    `${alter} TYPE json USING ${column.column}::json;`,
    column.default === null
      ? ''
      : `${alter} SET DEFAULT (${column.default})::json;`,
  ].join('\n');
};

export const definitionsKeepKeyOrder = defineMigration({
  name: '2026-11-01-definitions-keep-key-order',
  description:
    'Agent, guardrail, orchestration and workflow definitions and their version configs from jsonb to json, so they keep the key order written.',
  isApplied: async (context) => {
    return (await pending(context)).length === 0;
  },
  up: async (context) => {
    const columns = await pending(context);
    context.say(`converting ${columns.length} definition columns to json`);
    // One statement string, so no table is left half converted.
    await context.run({ sql: columns.map(alterColumn).join('\n') });
  },
});
