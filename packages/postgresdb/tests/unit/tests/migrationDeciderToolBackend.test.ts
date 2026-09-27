import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  dropDatabase,
  indexNames,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_decider_tool_backend_${process.pid}`;
const NAME = '2026-09-27-decider-tool-backend';

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
      CREATE TABLE agents (id serial PRIMARY KEY);
      CREATE TABLE tools (id serial PRIMARY KEY);
      CREATE TABLE deciders (
        id serial PRIMARY KEY,
        agent_id integer NOT NULL REFERENCES agents (id) ON DELETE RESTRICT
      );

      INSERT INTO agents DEFAULT VALUES;
      INSERT INTO tools DEFAULT VALUES;
      INSERT INTO deciders (agent_id) VALUES (1);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('tool_id exists, indexed', async () => {
    expect(
      await columnType({ client, table: 'deciders', column: 'tool_id' })
    ).toBe('integer');
    expect(await indexNames({ client, table: 'deciders' })).toEqual(
      expect.arrayContaining(['deciders_tool_id_idx'])
    );
  });

  test('a decider may name a tool and no agent', async () => {
    await client.query(`INSERT INTO deciders (tool_id) VALUES (1)`);

    const rows = await selectRows<{ agent_id: number | null }>({
      client,
      sql: 'SELECT agent_id FROM deciders WHERE tool_id = 1',
    });
    expect(rows).toEqual([{ agent_id: null }]);
  });

  test('a tool a decider names cannot be deleted', async () => {
    await expect(
      client.query('DELETE FROM tools WHERE id = 1')
    ).rejects.toThrow(/foreign key/);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
