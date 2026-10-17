import type { RunResult, Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_run_status_vocabulary_${process.pid}`;
const NAME = '2026-10-17-run-status-vocabulary';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const statuses = async (args: { client: Sequelize; table: string }) => {
  const rows = await selectRows<{ status: string }>({
    client: args.client,
    sql: `SELECT status::text AS status FROM ${args.table} ORDER BY id`,
  });
  return rows.map((row) => {
    return row.status;
  });
};

const enumLabels = async (args: { client: Sequelize; type: string }) => {
  const rows = await selectRows<{ label: string }>({
    client: args.client,
    sql: `SELECT e.enumlabel AS label FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = '${args.type}' ORDER BY e.enumsortorder`,
  });
  return rows.map((row) => {
    return row.label;
  });
};

beforeAll(async () => {
  await startDatabaseServer();
});

afterAll(async () => {
  await dropDatabase(DATABASE);
  await stopDatabaseServer();
});

describe(NAME, () => {
  let client: Sequelize;
  let firstRun: RunResult;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    // The tables as they stand before the change, reduced to the columns it
    // reads and writes.
    await client.query(`
      CREATE TYPE enum_orchestration_runs_status AS ENUM (
        'queued', 'running', 'sleeping', 'awaiting_input', 'succeeded',
        'failed', 'cancelled', 'expired');
      CREATE TABLE orchestration_runs (
        id serial PRIMARY KEY,
        status enum_orchestration_runs_status NOT NULL DEFAULT 'running');
      INSERT INTO orchestration_runs (status)
        VALUES ('succeeded'), ('failed'), ('awaiting_input');

      CREATE TYPE enum_webhook_deliveries_status AS ENUM (
        'pending', 'success', 'failed');
      CREATE TABLE webhook_deliveries (
        id serial PRIMARY KEY,
        status enum_webhook_deliveries_status NOT NULL DEFAULT 'pending');
      INSERT INTO webhook_deliveries (status)
        VALUES ('pending'), ('success'), ('failed');

      CREATE TABLE generations (
        id serial PRIMARY KEY,
        status varchar(32) NOT NULL DEFAULT 'in_progress');
      INSERT INTO generations (status)
        VALUES ('in_progress'), ('requires_action'), ('completed');

      CREATE TABLE eval_runs (id serial PRIMARY KEY, status varchar(255));
      INSERT INTO eval_runs (status) VALUES ('canceled'), ('completed');

      CREATE TABLE formation_operations (
        id serial PRIMARY KEY,
        status varchar(255) NOT NULL DEFAULT 'pending',
        events jsonb);
      INSERT INTO formation_operations (status, events) VALUES
        ('succeeded', '[{"logicalId":"a","status":"succeeded"},{"logicalId":"b","status":"failed"}]'),
        ('pending', NULL),
        ('failed', '[]');

      CREATE TABLE playbook_executions (id serial PRIMARY KEY, status varchar(16));
      INSERT INTO playbook_executions (status)
        VALUES ('pending'), ('running'), ('succeeded'), ('failed');

      CREATE TABLE playbook_exports (id serial PRIMARY KEY, status varchar(16));
      INSERT INTO playbook_exports (status) VALUES ('succeeded'), ('running');

      CREATE TABLE trigger_firings (
        id serial PRIMARY KEY, status varchar(255), result jsonb);
      INSERT INTO trigger_firings (status, result) VALUES
        ('succeeded', '{"target_type":"orchestration","status":"succeeded"}'),
        ('pending', NULL),
        ('succeeded', '{"target_type":"agent","status":"requires_action"}');

      CREATE TABLE webhooks (id serial PRIMARY KEY, events varchar(255)[]);
      INSERT INTO webhooks (events) VALUES
        ('{orchestration_runs.succeeded,orchestration_runs.failed}'),
        ('{agents.created}');

      CREATE TABLE triggers (id serial PRIMARY KEY, event_pattern varchar(255));
      INSERT INTO triggers (event_pattern) VALUES
        ('orchestration_runs.succeeded'), ('orchestration_runs.*'), (NULL);

      CREATE TABLE formations (id serial PRIMARY KEY, template jsonb);
      INSERT INTO formations (template) VALUES
        ('{"resources":{"t":{"type":"trigger","properties":{"event_pattern":"orchestration_runs.succeeded"}}}}');

      CREATE TABLE formation_resources (
        id serial PRIMARY KEY, last_applied_properties jsonb);
      INSERT INTO formation_resources (last_applied_properties) VALUES
        ('{"events":["orchestration_runs.succeeded"],"url":"https://example.com"}');
    `);

    firstRun = await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a database holding the legacy words runs it rather than detecting it', () => {
    expect(firstRun.applied).toEqual([NAME]);
  });

  test('a run that succeeded reads completed, every other status as it was', async () => {
    expect(await statuses({ client, table: 'orchestration_runs' })).toEqual([
      'completed',
      'failed',
      'awaiting_input',
    ]);
  });

  test("the run enum's value is renamed rather than added beside it", async () => {
    expect(
      await enumLabels({ client, type: 'enum_orchestration_runs_status' })
    ).toEqual([
      'queued',
      'running',
      'sleeping',
      'awaiting_input',
      'completed',
      'failed',
      'cancelled',
      'expired',
    ]);
  });

  test('a delivery reads queued or completed, and new rows default to queued', async () => {
    expect(
      await enumLabels({ client, type: 'enum_webhook_deliveries_status' })
    ).toEqual(['queued', 'completed', 'failed']);
    expect(await statuses({ client, table: 'webhook_deliveries' })).toEqual([
      'queued',
      'completed',
      'failed',
    ]);
    await client.query('INSERT INTO webhook_deliveries DEFAULT VALUES');
    expect(
      (await statuses({ client, table: 'webhook_deliveries' })).at(-1)
    ).toBe('queued');
  });

  test('a generation in flight reads running, and new rows default to it', async () => {
    expect(await statuses({ client, table: 'generations' })).toEqual([
      'running',
      'requires_action',
      'completed',
    ]);
    await client.query('INSERT INTO generations DEFAULT VALUES');
    expect((await statuses({ client, table: 'generations' })).at(-1)).toBe(
      'running'
    );
  });

  test('a cancelled eval run is spelled cancelled', async () => {
    expect(await statuses({ client, table: 'eval_runs' })).toEqual([
      'cancelled',
      'completed',
    ]);
  });

  test('a formation operation and each event it recorded use the shared words', async () => {
    expect(await statuses({ client, table: 'formation_operations' })).toEqual([
      'completed',
      'queued',
      'failed',
    ]);
    const rows = await selectRows<{ events: unknown }>({
      client,
      sql: 'SELECT events FROM formation_operations ORDER BY id',
    });
    expect(
      rows.map((row) => {
        return row.events;
      })
    ).toEqual([
      [
        { logicalId: 'a', status: 'completed' },
        { logicalId: 'b', status: 'failed' },
      ],
      null,
      [],
    ]);
  });

  test('playbook executions and exports use the shared words', async () => {
    expect(await statuses({ client, table: 'playbook_executions' })).toEqual([
      'queued',
      'running',
      'completed',
      'failed',
    ]);
    expect(await statuses({ client, table: 'playbook_exports' })).toEqual([
      'completed',
      'running',
    ]);
  });

  test('a firing and the run status its result recorded use the shared words', async () => {
    expect(await statuses({ client, table: 'trigger_firings' })).toEqual([
      'completed',
      'queued',
      'completed',
    ]);
    const rows = await selectRows<{ result: unknown }>({
      client,
      sql: 'SELECT result FROM trigger_firings ORDER BY id',
    });
    expect(
      rows.map((row) => {
        return row.result;
      })
    ).toEqual([
      { target_type: 'orchestration', status: 'completed' },
      null,
      { target_type: 'agent', status: 'requires_action' },
    ]);
  });

  test('every subscription to the run event names it by its new name', async () => {
    const webhooks = await selectRows<{ events: string[] }>({
      client,
      sql: 'SELECT events FROM webhooks ORDER BY id',
    });
    expect(
      webhooks.map((row) => {
        return row.events;
      })
    ).toEqual([
      ['orchestration_runs.completed', 'orchestration_runs.failed'],
      ['agents.created'],
    ]);
    const triggers = await selectRows<{ event_pattern: string | null }>({
      client,
      sql: 'SELECT event_pattern FROM triggers ORDER BY id',
    });
    expect(
      triggers.map((row) => {
        return row.event_pattern;
      })
    ).toEqual(['orchestration_runs.completed', 'orchestration_runs.*', null]);
  });

  test('a stored template and what it last applied name the run event by its new name', async () => {
    const formations = await selectRows<{ template: unknown }>({
      client,
      sql: 'SELECT template FROM formations',
    });
    expect(formations[0].template).toEqual({
      resources: {
        t: {
          type: 'trigger',
          properties: { event_pattern: 'orchestration_runs.completed' },
        },
      },
    });
    const resources = await selectRows<{ last_applied_properties: unknown }>({
      client,
      sql: 'SELECT last_applied_properties FROM formation_resources',
    });
    expect(resources[0].last_applied_properties).toEqual({
      events: ['orchestration_runs.completed'],
      url: 'https://example.com',
    });
  });

  test('re-running it is a no-op', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });
    expect(result.applied).toEqual([]);
  });
});

describe(`${NAME} on a database that predates the tables`, () => {
  const EMPTY = `${DATABASE}_empty`;
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(EMPTY);
  });

  afterAll(async () => {
    await client.close();
    await dropDatabase(EMPTY);
  });

  test('it records itself without running', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });
    expect(result.detected).toEqual([NAME]);
  });
});

describe(`${NAME} after a sync added the new label beside the old`, () => {
  const SYNCED = `${DATABASE}_synced`;
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(SYNCED);
    await client.query(`
      CREATE TYPE enum_orchestration_runs_status AS ENUM (
        'running', 'succeeded', 'failed', 'completed');
      CREATE TABLE orchestration_runs (
        id serial PRIMARY KEY,
        status enum_orchestration_runs_status NOT NULL DEFAULT 'running');
      INSERT INTO orchestration_runs (status) VALUES ('succeeded'), ('failed');
    `);
    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
    await dropDatabase(SYNCED);
  });

  test('the rows move to the label that is already there', async () => {
    expect(await statuses({ client, table: 'orchestration_runs' })).toEqual([
      'completed',
      'failed',
    ]);
  });
});
