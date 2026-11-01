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

const DATABASE = `soat_migration_payloads_key_order_${process.pid}`;
const NAME = '2026-11-01-payloads-keep-key-order';

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
      CREATE TABLE orchestration_runs (
        id serial PRIMARY KEY,
        input jsonb,
        state jsonb NOT NULL DEFAULT '{}'::jsonb,
        active_nodes jsonb NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE documents (
        id serial PRIMARY KEY,
        metadata jsonb,
        error jsonb
      );
      INSERT INTO orchestration_runs (input) VALUES ('{"zebra": 1, "apple": 2}');
      INSERT INTO documents (metadata, error)
      VALUES ('{"k": "v"}', '{"code": "X", "message": "m"}');
    `);
  });

  afterAll(async () => {
    await client.close();
  });

  describe('after it runs', () => {
    beforeAll(async () => {
      await runnerFor({ client }).run({ names: [NAME] });
    });

    test('every listed column is json, defaults kept', async () => {
      for (const column of ['input', 'state', 'active_nodes']) {
        expect(
          await columnType({ client, table: 'orchestration_runs', column })
        ).toBe('json');
      }
      expect(
        await columnType({ client, table: 'documents', column: 'error' })
      ).toBe('json');

      await client.query('INSERT INTO orchestration_runs DEFAULT VALUES');
      const [row] = await selectRows<{ state: unknown; active_nodes: unknown }>(
        {
          client,
          sql: 'SELECT state, active_nodes FROM orchestration_runs WHERE input IS NULL',
        }
      );
      expect(row).toEqual({ state: {}, active_nodes: [] });
    });

    test('a column the server queries stays jsonb', async () => {
      expect(
        await columnType({ client, table: 'documents', column: 'metadata' })
      ).toBe('jsonb');
    });

    test('stored values survive', async () => {
      const [run] = await selectRows<{ input: unknown }>({
        client,
        sql: 'SELECT input FROM orchestration_runs WHERE input IS NOT NULL',
      });
      expect(run.input).toEqual({ apple: 2, zebra: 1 });
    });

    test('a json column keeps the key order it is written in', async () => {
      await client.query(
        `UPDATE orchestration_runs SET input = '{"zebra": 1, "apple": 2}'
          WHERE input IS NOT NULL`
      );
      const [run] = await selectRows<{ input: object }>({
        client,
        sql: 'SELECT input FROM orchestration_runs WHERE input IS NOT NULL',
      });
      expect(Object.keys(run.input)).toEqual(['zebra', 'apple']);
    });
  });
});
