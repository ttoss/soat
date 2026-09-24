import type { Sequelize as Client } from '@ttoss/postgresdb';
import { createMigrationRunner, Sequelize } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS, models } from '../../../dist/index.cjs';
import {
  countRows,
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
  tableExists,
} from './migrationFixtures';

jest.setTimeout(180_000);

/**
 * Every foreign-key column a database holds `NOT NULL`.
 *
 * `sync({ alter: true })` rewrites a column that carries `references` as its
 * foreign key alone, never its nullability, so a model that relaxes or tightens
 * one changes nothing in a database that already has the column. Changing this
 * set therefore means a migration in `src/migrations/` that makes the same
 * change, the way `2026-09-24-foreign-key-nullability` relaxes four.
 */
const NOT_NULL_FOREIGN_KEYS = [
  'activity_entries.project_id',
  'actors.project_id',
  'agent_versions.agent_id',
  'agents.project_id',
  'ai_providers.project_id',
  'api_keys.user_id',
  'approval_items.project_id',
  'chats.project_id',
  'conversation_messages.conversation_id',
  'conversation_messages.document_id',
  'conversations.project_id',
  'dataset_items.dataset_id',
  'datasets.project_id',
  'document_chunks.document_id',
  'document_relations.from_document_id',
  'document_relations.to_document_id',
  'document_versions.document_id',
  'documents.file_id',
  'eval_results.eval_run_id',
  'eval_run_tasks.dataset_item_id',
  'eval_run_tasks.eval_run_id',
  'eval_runs.eval_id',
  'evals.agent_id',
  'evals.dataset_id',
  'evals.project_id',
  'exception_items.project_id',
  'files.project_id',
  'formation_resources.formation_id',
  'formations.project_id',
  'generation_chains.project_id',
  'generations.agent_id',
  'generations.project_id',
  'generations.trace_id',
  'guardrail_evaluations.project_id',
  'guardrail_versions.guardrail_id',
  'guardrails.project_id',
  'ingestion_rules.project_id',
  'memories.content_id',
  'memories.memory_store_id',
  'memory_assertions.content_id',
  'memory_assertions.memory_store_id',
  'memory_contents.memory_store_id',
  'memory_rules.memory_store_id',
  'memory_stores.project_id',
  'metadata_schemas.project_id',
  'model_routes.project_id',
  'orchestration_checkpoints.orchestration_run_id',
  'orchestration_node_executions.orchestration_run_id',
  'orchestration_run_tasks.orchestration_run_id',
  'orchestration_runs.orchestration_id',
  'orchestration_runs.project_id',
  'orchestration_versions.orchestration_id',
  'orchestrations.project_id',
  'quota_window_counters.quota_id',
  'quotas.project_id',
  'secrets.project_id',
  'sessions.agent_id',
  'sessions.conversation_id',
  'sessions.project_id',
  'task_transitions.task_id',
  'tasks.project_id',
  'tasks.workflow_id',
  'tools.project_id',
  'traces.agent_id',
  'traces.project_id',
  'trigger_firings.project_id',
  'trigger_firings.trigger_id',
  'triggers.project_id',
  'upload_tokens.project_id',
  'usage_components.usage_event_id',
  'usage_events.project_id',
  'usage_thresholds.project_id',
  'webhook_deliveries.webhook_id',
  'webhooks.project_id',
  'workflow_versions.workflow_id',
  'workflows.project_id',
];

const modelList = Object.values(models);

// Registering the models resolves decorator metadata into attributes;
// `underscored` mirrors `initialize()`. No connection is opened.
new Sequelize({
  dialect: 'postgres',
  define: { underscored: true },
  models: modelList,
});

const declaredNotNull = (): string[] => {
  return modelList
    .flatMap((model) => {
      return Object.values(model.getAttributes())
        .filter((attribute) => {
          return attribute.references && attribute.allowNull === false;
        })
        .map((attribute) => {
          return `${model.getTableName()}.${attribute.field}`;
        });
    })
    .sort();
};

test('the models declare the foreign-key nullability the database holds', () => {
  expect(declaredNotNull()).toEqual([...NOT_NULL_FOREIGN_KEYS].sort());
});

let client: Client;

const DATABASE = `soat_fk_nullability_${process.pid}`;

const runner = () => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: client,
    log: () => {
      return undefined;
    },
  });
};

describe('2026-09-24-foreign-key-nullability', () => {
  // `chats.ai_provider_id` is relaxed too; its table is left out of this
  // database to prove a missing table is skipped.
  const HELD = [
    { table: 'agents', column: 'ai_provider_id' },
    { table: 'api_keys', column: 'project_id' },
    { table: 'conversation_messages', column: 'actor_id' },
  ];

  const isNullable = async (args: { table: string; column: string }) => {
    const [row] = await selectRows<{ is_nullable: string }>({
      client,
      sql: `SELECT is_nullable FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = '${args.table}' AND column_name = '${args.column}'`,
    });

    return row.is_nullable === 'YES';
  };

  beforeAll(async () => {
    await startDatabaseServer();
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE projects (id serial PRIMARY KEY);
      CREATE TABLE ai_providers (id serial PRIMARY KEY);
      CREATE TABLE actors (id serial PRIMARY KEY);

      CREATE TABLE agents (
        id serial PRIMARY KEY,
        ai_provider_id integer NOT NULL REFERENCES ai_providers (id)
      );
      CREATE TABLE api_keys (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects (id)
      );
      CREATE TABLE conversation_messages (
        id serial PRIMARY KEY,
        actor_id integer NOT NULL REFERENCES actors (id)
      );

      INSERT INTO ai_providers DEFAULT VALUES;
      INSERT INTO agents (ai_provider_id) VALUES (1);
    `);

    await runner().run({
      names: ['2026-09-24-foreign-key-nullability'],
    });
  });

  afterAll(async () => {
    await client.close();
    await dropDatabase(DATABASE);
    await stopDatabaseServer();
  });

  test('every relaxed column the database holds accepts a null', async () => {
    for (const target of HELD) {
      expect(await isNullable(target)).toBe(true);
    }
  });

  test('an agent can be stored without a pinned provider', async () => {
    await client.query('INSERT INTO agents (ai_provider_id) VALUES (NULL)');

    expect(
      await countRows({
        client,
        sql: 'SELECT count(*) FROM agents WHERE ai_provider_id IS NULL',
      })
    ).toBe(1);
  });

  test('the foreign key still holds', async () => {
    await expect(
      client.query('INSERT INTO agents (ai_provider_id) VALUES (999)')
    ).rejects.toThrow(/foreign key/);
  });

  test('a table the database has not got is skipped, not failed', async () => {
    expect(await tableExists({ client, table: 'chats' })).toBe(false);
  });

  test('re-running it is a no-op', async () => {
    const result = await runner().run({
      names: ['2026-09-24-foreign-key-nullability'],
    });

    expect(result.applied).toEqual([]);
  });
});
