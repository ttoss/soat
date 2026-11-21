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

const DATABASE = `soat_migration_eval_claim_${process.pid}`;
const NAME = '2026-11-21-eval-claim';

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
        eval_id integer NOT NULL REFERENCES evals (id)
      );
      INSERT INTO evals DEFAULT VALUES;
      INSERT INTO eval_runs (eval_id) VALUES (1);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('adds the claim columns as json', async () => {
    expect(await columnType({ client, table: 'evals', column: 'claim' })).toBe(
      'json'
    );
    expect(
      await columnType({ client, table: 'eval_runs', column: 'claim' })
    ).toBe('json');
  });

  test('leaves existing rows with no claim', async () => {
    expect(
      await selectRows<{ claim: unknown }>({
        client,
        sql: 'SELECT claim FROM eval_runs WHERE id = 1',
      })
    ).toEqual([{ claim: null }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
