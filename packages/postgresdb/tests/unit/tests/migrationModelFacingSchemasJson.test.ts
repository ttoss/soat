import type { Sequelize } from '@ttoss/postgresdb';
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

const DATABASE = `soat_migration_model_facing_schemas_json_${process.pid}`;
const NAME = '2026-11-01-model-facing-schemas-json';

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

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE agents (id serial PRIMARY KEY, output_schema jsonb);
      CREATE TABLE tools (id serial PRIMARY KEY, parameters jsonb);

      INSERT INTO agents (output_schema) VALUES
        ('{"type":"object","properties":{"reasoning":{},"answer":{}}}'),
        (NULL);
      INSERT INTO tools (parameters) VALUES ('{"type":"object"}'), (NULL);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('both columns are json', async () => {
    expect(
      await columnType({ client, table: 'agents', column: 'output_schema' })
    ).toBe('json');
    expect(
      await columnType({ client, table: 'tools', column: 'parameters' })
    ).toBe('json');
  });

  test('existing values and nulls are kept', async () => {
    expect(
      await selectRows<{ output_schema: unknown }>({
        client,
        sql: 'SELECT output_schema FROM agents ORDER BY id',
      })
    ).toEqual([
      {
        output_schema: {
          type: 'object',
          properties: { answer: {}, reasoning: {} },
        },
      },
      { output_schema: null },
    ]);
    expect(
      await selectRows<{ parameters: unknown }>({
        client,
        sql: 'SELECT parameters FROM tools ORDER BY id',
      })
    ).toEqual([{ parameters: { type: 'object' } }, { parameters: null }]);
  });

  test('a new write keeps its key order', async () => {
    await client.query(
      `INSERT INTO agents (output_schema) VALUES ('{"reasoning":1,"answer":2}')`
    );

    const [row] = await selectRows<{ output_schema: object }>({
      client,
      sql: 'SELECT output_schema FROM agents ORDER BY id DESC LIMIT 1',
    });
    expect(Object.keys(row.output_schema)).toEqual(['reasoning', 'answer']);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
