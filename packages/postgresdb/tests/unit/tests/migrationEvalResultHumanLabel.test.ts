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

const DATABASE = `soat_migration_eval_result_human_label_${process.pid}`;
const NAME = '2026-11-22-eval-result-human-label';

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
      CREATE TABLE eval_results (id serial PRIMARY KEY);
      INSERT INTO eval_results DEFAULT VALUES;
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test.each([
    ['human_passed', 'boolean'],
    ['label_note', 'text'],
    ['labeled_by_principal_type', 'character varying'],
    ['labeled_by_principal_id', 'character varying'],
    ['labeled_at', 'timestamp with time zone'],
  ])('adds %s as %s', async (column, type) => {
    expect(await columnType({ client, table: 'eval_results', column })).toBe(
      type
    );
  });

  test('leaves existing results unlabeled', async () => {
    expect(
      await selectRows<{ human_passed: unknown; labeled_at: unknown }>({
        client,
        sql: 'SELECT human_passed, labeled_at FROM eval_results WHERE id = 1',
      })
    ).toEqual([{ human_passed: null, labeled_at: null }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
