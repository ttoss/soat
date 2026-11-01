import type { RunResult, Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_definitions_key_order_${process.pid}`;
const NAME = '2026-11-01-definitions-keep-key-order';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
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

    // Two of the tables, reduced to columns it converts, plus one it leaves.
    await client.query(`
      CREATE TABLE workflows (
        id serial PRIMARY KEY,
        states jsonb NOT NULL DEFAULT '[]'::jsonb,
        payload_schema jsonb);
      INSERT INTO workflows (payload_schema) VALUES ('{"type":"object"}');

      CREATE TABLE agents (
        id serial PRIMARY KEY,
        boundary_policy jsonb,
        output_schema jsonb);
      INSERT INTO agents (boundary_policy) VALUES ('{"statement":[]}');
    `);

    firstRun = await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a database holding jsonb definitions runs it', () => {
    expect(firstRun.applied).toEqual([NAME]);
  });

  test('every listed column is json, and no other one moves', async () => {
    const types = await Promise.all(
      [
        ['workflows', 'states'],
        ['workflows', 'payload_schema'],
        ['agents', 'boundary_policy'],
        ['agents', 'output_schema'],
      ].map(([table, column]) => {
        return columnType({ client, table, column });
      })
    );
    expect(types).toEqual(['json', 'json', 'json', 'jsonb']);
  });

  test('stored values and defaults survive the conversion', async () => {
    await client.query('INSERT INTO workflows DEFAULT VALUES');
    const rows = await selectRows<{
      states: unknown;
      payload_schema: unknown;
    }>({
      client,
      sql: 'SELECT states, payload_schema FROM workflows ORDER BY id',
    });
    expect(rows).toEqual([
      { states: [], payload_schema: { type: 'object' } },
      { states: [], payload_schema: null },
    ]);
  });

  test('a write keeps its key order', async () => {
    await client.query(
      `UPDATE workflows SET payload_schema = '{"title":1,"id":2}' WHERE id = 1`
    );
    const [row] = await selectRows<{ text: string }>({
      client,
      sql: 'SELECT payload_schema::text AS text FROM workflows WHERE id = 1',
    });
    expect(row.text).toBe('{"title":1,"id":2}');
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
