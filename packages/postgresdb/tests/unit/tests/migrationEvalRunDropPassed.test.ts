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

const DATABASE = `soat_migration_eval_run_drop_passed_${process.pid}`;
const NAME = '2026-11-21-eval-run-drop-passed';

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
      CREATE TABLE eval_runs (
        id serial PRIMARY KEY,
        passed boolean,
        verdict varchar(16)
      );
      INSERT INTO eval_runs (passed, verdict) VALUES (true, 'supported');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('drops passed and keeps the verdict', async () => {
    expect(
      await columnType({ client, table: 'eval_runs', column: 'passed' })
    ).toBeUndefined();
    expect(
      await selectRows<{ verdict: string }>({
        client,
        sql: 'SELECT verdict FROM eval_runs WHERE id = 1',
      })
    ).toEqual([{ verdict: 'supported' }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
