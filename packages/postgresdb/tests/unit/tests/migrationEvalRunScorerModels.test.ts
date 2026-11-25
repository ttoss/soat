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

const DATABASE = `soat_migration_eval_run_scorer_models_${process.pid}`;
const NAME = '2026-11-25-eval-run-scorer-models';

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
      CREATE TABLE eval_runs (id serial PRIMARY KEY);
      INSERT INTO eval_runs DEFAULT VALUES;
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('adds eval_runs.scorer_models as json', async () => {
    expect(
      await columnType({ client, table: 'eval_runs', column: 'scorer_models' })
    ).toBe('json');
  });

  test('leaves existing runs with no pins', async () => {
    expect(
      await selectRows<{ scorer_models: unknown }>({
        client,
        sql: 'SELECT scorer_models FROM eval_runs WHERE id = 1',
      })
    ).toEqual([{ scorer_models: null }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
