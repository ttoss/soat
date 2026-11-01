import { defineMigration } from '@ttoss/postgresdb';

/**
 * Payload, record and configuration columns to `json`, which keeps an object's
 * keys in the order they were written where `jsonb` sorts them. Each is
 * classified `order` in `tests/harness/jsonColumnRoles.test.mjs`. `sync` never
 * changes a column's type. A row already stored keeps the order `jsonb` gave it.
 */
const PAYLOAD_COLUMNS: Record<string, string[]> = {
  activity_entries: ['detail'],
  agents: ['active_release'],
  ai_providers: ['config'],
  approval_items: [
    'edited_arguments',
    'evidence',
    'proposed_action',
    'task_payload',
  ],
  audit_entries: ['detail', 'on_behalf_of'],
  conversation_messages: ['metadata', 'response_messages'],
  dataset_items: ['input', 'metadata'],
  decisions: ['answers', 'error', 'metadata'],
  document_versions: ['config'],
  documents: ['error'],
  eval_results: ['error', 'input', 'scores'],
  eval_runs: [
    'aggregate_scores',
    'decider_versions',
    'metadata',
    'tool_context',
  ],
  evals: ['scorers'],
  exception_items: ['detail'],
  files: ['metadata'],
  formation_operations: ['error', 'events', 'plan'],
  formation_resources: [
    'last_applied_properties',
    'pending_cleanup_physical_resource_ids',
  ],
  formations: [
    'error',
    'metadata',
    'outputs',
    'resolved_metadata',
    'resolved_parameters',
    'template',
  ],
  generations: [
    'error',
    'extraction',
    'input_messages',
    'input_modalities',
    'metadata',
    'pending_state',
    'retrieval',
    'routing',
    'tool_surface',
  ],
  guardrail_evaluations: ['context_snapshot'],
  ingestion_rules: ['metadata', 'preset_parameters'],
  memories: ['metadata'],
  memory_rules: ['preset_parameters', 'source_agent_ids'],
  metadata_schemas: ['schema'],
  model_routes: ['retry_on', 'targets'],
  oauth_auth_codes: ['code_data'],
  oauth_clients: ['client_data'],
  orchestration_checkpoints: ['artifacts', 'state'],
  orchestration_node_executions: ['error', 'input', 'output'],
  orchestration_runs: [
    'active_nodes',
    'artifacts',
    'error',
    'input',
    'metadata',
    'output',
    'required_action',
    'state',
    'tool_context',
    'wake_context',
  ],
  playbook_entries: ['basis', 'on_behalf_of'],
  playbook_executions: ['basis', 'error', 'on_behalf_of'],
  playbook_exports: ['error', 'on_behalf_of'],
  playbook_upgrades: ['diff', 'on_behalf_of'],
  policies: ['document'],
  price_books: ['quantity'],
  projects: ['guardrail_ids'],
  sessions: ['tool_context'],
  shares: ['actions', 'cap'],
  tasks: ['active_dispatch', 'last_result', 'payload', 'tool_context'],
  tools: [
    'actions',
    'context_keys',
    'denied_actions',
    'execute',
    'guardrail_ids',
    'mcp',
    'output_mapping',
    'pipeline',
    'preset_parameters',
  ],
  traces: ['error', 'step_segments'],
  trigger_firings: ['causation_chain', 'error', 'input', 'result'],
  triggers: ['input', 'tool_context'],
  webhook_deliveries: ['payload'],
  workflow_migrations: ['items', 'state_map'],
};

type Context = {
  select: <T>(args: { sql: string }) => Promise<T[]>;
};

/** The listed columns still `jsonb`, by table. */
const jsonbColumns = async (args: {
  context: Context;
}): Promise<Map<string, string[]>> => {
  const rows = await args.context.select<{
    table_name: string;
    column_name: string;
  }>({
    sql: `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND data_type = 'jsonb'
            ORDER BY table_name, column_name`,
  });
  const pending = new Map<string, string[]>();
  for (const row of rows) {
    if (!PAYLOAD_COLUMNS[row.table_name]?.includes(row.column_name)) continue;
    pending.set(row.table_name, [
      ...(pending.get(row.table_name) ?? []),
      row.column_name,
    ]);
  }
  return pending;
};

export const payloadsKeepKeyOrder = defineMigration({
  name: '2026-11-01-payloads-keep-key-order',
  description:
    'Payload, record and configuration columns from jsonb to json, so an object reads back in the key order it was written.',
  isApplied: async (context) => {
    return (await jsonbColumns({ context })).size === 0;
  },
  up: async (context) => {
    for (const [table, columns] of await jsonbColumns({ context })) {
      context.say(`converting ${table}.${columns.join(', ')} to json`);
      // One statement per table, so each table is rewritten once.
      await context.run({
        sql: `ALTER TABLE "${table}" ${columns
          .map((column) => {
            return `ALTER COLUMN "${column}" TYPE json USING "${column}"::json`;
          })
          .join(', ')}`,
      });
    }
  },
});
