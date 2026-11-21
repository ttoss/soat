import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  dropDatabase,
  selectRows,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_agent_version_claims_${process.pid}`;
const NAME = '2026-11-21-agent-version-claims';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

afterAll(async () => {
  await dropDatabase(DATABASE);
});

describe(NAME, () => {
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE agent_versions (id serial PRIMARY KEY, version integer NOT NULL);
      INSERT INTO agent_versions (version) VALUES (1);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('adds the released_claims column as json', async () => {
    expect(
      await columnType({
        client,
        table: 'agent_versions',
        column: 'released_claims',
      })
    ).toBe('json');
  });

  test('leaves existing versions with no record', async () => {
    expect(
      await selectRows<{ released_claims: unknown }>({
        client,
        sql: 'SELECT released_claims FROM agent_versions WHERE id = 1',
      })
    ).toEqual([{ released_claims: null }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
