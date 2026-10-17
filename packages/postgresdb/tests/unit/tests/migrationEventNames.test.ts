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

const DATABASE = `soat_migration_event_names_${process.pid}`;
const NAME = '2026-10-17-event-names';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const column = async <T>(args: {
  client: Sequelize;
  table: string;
  column: string;
}): Promise<T[]> => {
  const rows = await selectRows<{ value: T }>({
    client: args.client,
    sql: `SELECT ${args.column} AS value FROM ${args.table} ORDER BY id`,
  });
  return rows.map((row) => {
    return row.value;
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
      CREATE TABLE webhooks (id serial PRIMARY KEY, events varchar(255)[]);
      INSERT INTO webhooks (events) VALUES
        ('{agents.generation.completed,files.created,sessions.generation.completed}'),
        ('{eval_run.*,quota.exceeded,guardrail.tripwire,audit.entry_created}'),
        ('{conversations.message.generated,usage.threshold_crossed,sessions.generation.started}'),
        ('{agents.*,generations.content_purged}');

      CREATE TABLE triggers (id serial PRIMARY KEY, event_pattern varchar(255));
      INSERT INTO triggers (event_pattern) VALUES
        ('agents.generation.*'), ('sessions.generation.requires_action'),
        ('conversations.message.*'), ('usage.*'), ('agents.*'), (NULL);

      CREATE TABLE memory_rules (id serial PRIMARY KEY, "on" varchar(64) NOT NULL);
      INSERT INTO memory_rules ("on") VALUES
        ('agents.generation.completed'), ('conversations.message.generated');

      CREATE TABLE formations (id serial PRIMARY KEY, template jsonb);
      INSERT INTO formations (template) VALUES
        ('{"resources":{"t":{"type":"trigger","properties":{"event_pattern":"eval_run.completed"}},"r":{"type":"memory_rule","properties":{"on":"agents.generation.completed"}}}}');

      CREATE TABLE formation_resources (
        id serial PRIMARY KEY, last_applied_properties jsonb);
      INSERT INTO formation_resources (last_applied_properties) VALUES
        ('{"events":["agents.generation.failed","quota.*"],"url":"https://example.com"}');
    `);

    firstRun = await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a database holding the old names runs it rather than detecting it', () => {
    expect(firstRun.applied).toEqual([NAME]);
  });

  test('a webhook subscribes by the new names, once each, in its order', async () => {
    expect(
      await column<string[]>({ client, table: 'webhooks', column: 'events' })
    ).toEqual([
      ['generations.completed', 'files.created'],
      [
        'eval_runs.*',
        'quotas.exceeded',
        'guardrails.tripwire',
        'audit_entries.created',
      ],
      [
        'conversation_messages.generated',
        'usage_thresholds.crossed',
        'sessions.generation_started',
      ],
      ['agents.*', 'generations.content_purged'],
    ]);
  });

  test('a trigger pattern names the new event or namespace', async () => {
    expect(
      await column<string | null>({
        client,
        table: 'triggers',
        column: 'event_pattern',
      })
    ).toEqual([
      'generations.*',
      'generations.requires_action',
      'conversation_messages.*',
      'usage_thresholds.*',
      'agents.*',
      null,
    ]);
  });

  test('a memory rule binds to the new name', async () => {
    expect(
      await column<string>({ client, table: 'memory_rules', column: '"on"' })
    ).toEqual(['generations.completed', 'conversation_messages.generated']);
  });

  test('a stored template and what it last applied use the new names', async () => {
    expect(
      await column<unknown>({ client, table: 'formations', column: 'template' })
    ).toEqual([
      {
        resources: {
          t: {
            type: 'trigger',
            properties: { event_pattern: 'eval_runs.completed' },
          },
          r: {
            type: 'memory_rule',
            properties: { on: 'generations.completed' },
          },
        },
      },
    ]);
    expect(
      await column<unknown>({
        client,
        table: 'formation_resources',
        column: 'last_applied_properties',
      })
    ).toEqual([
      {
        events: ['generations.failed', 'quotas.*'],
        url: 'https://example.com',
      },
    ]);
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
