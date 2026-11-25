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

const DATABASE = `soat_migration_eval_criteria_${process.pid}`;
const NAME = '2026-11-24-eval-criteria';

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
      CREATE TABLE evals (id serial PRIMARY KEY);
      INSERT INTO evals DEFAULT VALUES;
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('adds evals.criteria as json', async () => {
    expect(
      await columnType({ client, table: 'evals', column: 'criteria' })
    ).toBe('json');
  });

  test('leaves existing evals with no criteria', async () => {
    expect(
      await selectRows<{ criteria: unknown }>({
        client,
        sql: 'SELECT criteria FROM evals WHERE id = 1',
      })
    ).toEqual([{ criteria: null }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
