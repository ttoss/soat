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

const DATABASE = `soat_migration_agent_policy_ids_${process.pid}`;
const NAME = '2026-11-10-agent-policy-ids';

const BOUNDARY = '{"statement":[{"effect":"Deny","action":["*"]}]}';
const OLDER = '{"statement":[{"effect":"Allow","action":["files:*"]}]}';

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

  type Policy = { public_id: string; document: unknown };

  const policies = (): Promise<Policy[]> => {
    return selectRows<Policy>({
      client,
      sql: 'SELECT public_id, document FROM policies ORDER BY id',
    });
  };

  const agentPolicyIds = async (publicId: string): Promise<unknown> => {
    const [row] = await selectRows<{ policy_ids: unknown }>({
      client,
      sql: `SELECT policy_ids FROM agents WHERE public_id = '${publicId}'`,
    });
    return row.policy_ids;
  };

  const versionConfigs = (): Promise<{ text: string }[]> => {
    return selectRows<{ text: string }>({
      client,
      sql: 'SELECT config::text AS text FROM agent_versions ORDER BY id',
    });
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE policies (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        name varchar(255),
        description text,
        document json NOT NULL,
        created_at timestamptz,
        updated_at timestamptz);
      CREATE TABLE agents (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        boundary_policy json);
      CREATE TABLE agent_versions (
        id serial PRIMARY KEY,
        agent_id integer NOT NULL REFERENCES agents (id),
        config json NOT NULL);

      INSERT INTO agents (public_id, boundary_policy)
        VALUES ('agt_bounded', '${BOUNDARY}'), ('agt_open', NULL);
      INSERT INTO agent_versions (agent_id, config) VALUES
        (1, '{"name":"a","boundary_policy":${OLDER},"temperature":1}'),
        (1, '{"name":"a","boundary_policy":${BOUNDARY},"temperature":1}'),
        (2, '{"name":"b","boundary_policy":null,"temperature":1}');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('each distinct boundary of an agent becomes one policy', async () => {
    const rows = await policies();

    expect(
      rows.map((row) => {
        return row.document;
      })
    ).toEqual([JSON.parse(BOUNDARY), JSON.parse(OLDER)]);
    for (const row of rows) expect(row.public_id).toMatch(/^pol_/);
  });

  test('the agent carries the policy made from its boundary', async () => {
    const [current] = await policies();

    expect(await agentPolicyIds('agt_bounded')).toEqual([current.public_id]);
    expect(await agentPolicyIds('agt_open')).toBeNull();
  });

  test('every version names policies in place of the boundary, key order kept', async () => {
    const [current, older] = await policies();

    expect(await versionConfigs()).toEqual([
      {
        text: `{"name":"a","policy_ids":["${older.public_id}"],"temperature":1}`,
      },
      {
        text: `{"name":"a","policy_ids":["${current.public_id}"],"temperature":1}`,
      },
      { text: '{"name":"b","policy_ids":null,"temperature":1}' },
    ]);
  });

  test('boundary_policy is gone and policy_ids is jsonb', async () => {
    expect(
      await columnType({ client, table: 'agents', column: 'boundary_policy' })
    ).toBeUndefined();
    expect(
      await columnType({ client, table: 'agents', column: 'policy_ids' })
    ).toBe('jsonb');
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
