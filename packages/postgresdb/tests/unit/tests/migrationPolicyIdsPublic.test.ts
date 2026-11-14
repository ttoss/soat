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

const DATABASE = `soat_migration_policy_ids_public_${process.pid}`;
const NAME = '2026-11-13-policy-ids-public';

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

  const policyIdsOf = async (table: string, id: number): Promise<string[]> => {
    const [row] = await selectRows<{ policy_ids: string[] }>({
      client,
      sql: `SELECT policy_ids FROM ${table} WHERE id = ${id}`,
    });
    return row.policy_ids;
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);
    await client.query(`
      CREATE TABLE policies (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL);
      CREATE TABLE users (
        id serial PRIMARY KEY,
        policy_ids integer[] NOT NULL DEFAULT '{}');
      CREATE TABLE api_keys (
        id serial PRIMARY KEY,
        policy_ids integer[] NOT NULL DEFAULT '{}');

      INSERT INTO policies (public_id) VALUES ('pol_a'), ('pol_b'), ('pol_c');
      INSERT INTO users (policy_ids) VALUES ('{}'), ('{3,1}'), ('{2,9}');
      INSERT INTO api_keys (policy_ids) VALUES ('{}'), ('{2}'), ('{9}');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test.each(['users', 'api_keys'])(
    '%s keeps an empty list empty',
    async (table) => {
      expect(await policyIdsOf(table, 1)).toEqual([]);
    }
  );

  test('each id becomes its public id, in order', async () => {
    expect(await policyIdsOf('users', 2)).toEqual(['pol_c', 'pol_a']);
    expect(await policyIdsOf('api_keys', 2)).toEqual(['pol_b']);
  });

  test('a user drops an id naming no policy', async () => {
    expect(await policyIdsOf('users', 3)).toEqual(['pol_b']);
  });

  test('a key keeps an id naming no policy, so its cap is not lifted', async () => {
    expect(await policyIdsOf('api_keys', 3)).toEqual(['pol_unresolved_9']);
  });

  test('both columns hold strings', async () => {
    for (const table of ['users', 'api_keys']) {
      expect(await columnType({ client, table, column: 'policy_ids' })).toBe(
        'ARRAY'
      );
    }
    const [{ udt_name: udtName }] = await selectRows<{ udt_name: string }>({
      client,
      sql: `SELECT udt_name FROM information_schema.columns
             WHERE table_name = 'api_keys' AND column_name = 'policy_ids'`,
    });
    expect(udtName).toBe('_varchar');
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
