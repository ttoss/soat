import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import { createDatabase, dropDatabase, selectRows } from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_scorer_names_required_${process.pid}`;
const NAME = '2026-11-25-scorer-names-required';

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
      CREATE TABLE evals (id serial PRIMARY KEY, scorers json NOT NULL);
      CREATE TABLE eval_runs (id serial PRIMARY KEY, definition json);
      INSERT INTO evals (scorers) VALUES
        ('[{"type":"contains","value":"refund"},{"type":"exact_match","name":"exact"}]'),
        ('[{"name":"judge","type":"llm_judge","prompt":"p"}]');
      INSERT INTO eval_runs (definition) VALUES
        ('{"scorers":[{"type":"contains","value":"refund"}],"pass_threshold":0.5}'),
        (NULL),
        ('{"pass_threshold":0.5}');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('an unnamed scorer of an eval takes its type as its name, after its other keys', async () => {
    const rows = await selectRows<{ scorers: string }>({
      client,
      sql: 'SELECT scorers::text AS scorers FROM evals ORDER BY id',
    });
    const scorers = rows.map((row) => {
      return JSON.parse(row.scorers) as Array<Record<string, unknown>>;
    });

    expect(scorers).toEqual([
      [
        { type: 'contains', value: 'refund', name: 'contains' },
        { type: 'exact_match', name: 'exact' },
      ],
      [{ name: 'judge', type: 'llm_judge', prompt: 'p' }],
    ]);
    expect(Object.keys(scorers[0]![0]!)).toEqual(['type', 'value', 'name']);
    expect(rows[1]!.scorers).toBe(
      '[{"name":"judge","type":"llm_judge","prompt":"p"}]'
    );
  });

  test('an unnamed scorer of a run definition takes its type as its name', async () => {
    expect(
      await selectRows<{ definition: unknown }>({
        client,
        sql: 'SELECT definition FROM eval_runs ORDER BY id',
      })
    ).toEqual([
      {
        definition: {
          scorers: [{ type: 'contains', value: 'refund', name: 'contains' }],
          pass_threshold: 0.5,
        },
      },
      { definition: null },
      { definition: { pass_threshold: 0.5 } },
    ]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
