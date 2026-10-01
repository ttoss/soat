import type { Sequelize } from '@ttoss/postgresdb';
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

const DATABASE = `soat_migration_ingestion_rules_converter_${process.pid}`;
const NAME = '2026-09-30-ingestion-rules-outlive-converter';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

type RuleRow = {
  id: number;
  tool_id: number | null;
  tool_public_id: string | null;
  agent_id: number | null;
  agent_public_id: string | null;
};

const rules = async (client: Sequelize) => {
  return selectRows<RuleRow>({
    client,
    sql: `SELECT id, tool_id, tool_public_id, agent_id, agent_public_id
      FROM ingestion_rules ORDER BY id`,
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
      CREATE TABLE tools (id serial PRIMARY KEY, public_id varchar(32));
      CREATE TABLE agents (id serial PRIMARY KEY, public_id varchar(32));
      CREATE TABLE ingestion_rules (
        id serial PRIMARY KEY,
        tool_id integer REFERENCES tools (id) ON DELETE RESTRICT,
        agent_id integer REFERENCES agents (id) ON DELETE RESTRICT
      );

      INSERT INTO tools (public_id) VALUES ('tool_live');
      INSERT INTO agents (public_id) VALUES ('agt_live');
      INSERT INTO ingestion_rules (tool_id) VALUES (1);
      INSERT INTO ingestion_rules (agent_id) VALUES (1);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test("backfills each rule's converter public id", async () => {
    expect(await rules(client)).toEqual([
      {
        id: 1,
        tool_id: 1,
        tool_public_id: 'tool_live',
        agent_id: null,
        agent_public_id: null,
      },
      {
        id: 2,
        tool_id: null,
        tool_public_id: null,
        agent_id: 1,
        agent_public_id: 'agt_live',
      },
    ]);
  });

  test('deleting a converter clears the key and keeps the public id', async () => {
    await client.query('DELETE FROM tools WHERE id = 1');
    await client.query('DELETE FROM agents WHERE id = 1');

    const [toolRule, agentRule] = await rules(client);
    expect(toolRule).toMatchObject({
      tool_id: null,
      tool_public_id: 'tool_live',
    });
    expect(agentRule).toMatchObject({
      agent_id: null,
      agent_public_id: 'agt_live',
    });
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
