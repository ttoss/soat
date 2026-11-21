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

const DATABASE = `soat_migration_eval_run_verdict_${process.pid}`;
const NAME = '2026-11-21-eval-run-verdict';

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
      CREATE TABLE eval_runs (
        id serial PRIMARY KEY,
        eval_id integer NOT NULL REFERENCES evals (id),
        passed boolean
      );
      INSERT INTO evals DEFAULT VALUES;
      INSERT INTO eval_runs (eval_id, passed) VALUES (1, true);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('adds the evidence and verdict columns', async () => {
    expect(
      await columnType({ client, table: 'evals', column: 'evidence' })
    ).toBe('json');
    expect(
      await columnType({ client, table: 'eval_runs', column: 'verdict' })
    ).toBe('character varying');
    expect(
      await columnType({
        client,
        table: 'eval_runs',
        column: 'verdict_reasons',
      })
    ).toBe('json');
  });

  test('keeps passed for the previous release', async () => {
    expect(
      await selectRows<{ passed: boolean; verdict: string | null }>({
        client,
        sql: 'SELECT passed, verdict FROM eval_runs WHERE id = 1',
      })
    ).toEqual([{ passed: true, verdict: null }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
