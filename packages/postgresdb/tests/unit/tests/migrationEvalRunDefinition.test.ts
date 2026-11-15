import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_eval_run_definition_${process.pid}`;
const NAME = '2026-11-15-eval-run-definition';

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

  const runOf = async (id: number) => {
    const [row] = await selectRows<{
      agent_public_id: string | null;
      definition: unknown;
    }>({
      client,
      sql: `SELECT agent_public_id, definition FROM eval_runs WHERE id = ${id}`,
    });
    return row;
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE agents (id serial PRIMARY KEY, public_id varchar(32) NOT NULL);
      CREATE TABLE evals (
        id serial PRIMARY KEY,
        agent_id integer NOT NULL REFERENCES agents (id),
        scorers jsonb NOT NULL,
        pass_threshold numeric,
        group_by varchar(255)
      );
      CREATE TABLE eval_runs (
        id serial PRIMARY KEY,
        eval_id integer NOT NULL REFERENCES evals (id),
        status varchar(255) NOT NULL
      );

      INSERT INTO agents (public_id) VALUES ('agent_live');
      INSERT INTO evals (agent_id, scorers, pass_threshold, group_by)
        VALUES (1, '[{"type":"contains","value":"refund"}]', 0.8, 'kind'),
               (1, '[{"type":"exact_match"}]', NULL, NULL);
      INSERT INTO eval_runs (eval_id, status)
        VALUES (1, 'queued'), (1, 'running'), (1, 'completed'), (2, 'queued');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('adds both columns', async () => {
    expect(
      await columnType({
        client,
        table: 'eval_runs',
        column: 'agent_public_id',
      })
    ).toBe('character varying');
    expect(
      await columnType({ client, table: 'eval_runs', column: 'definition' })
    ).toBe('json');
  });

  test.each([1, 2])(
    'a live run takes its Eval agent and definition (run %d)',
    async (id) => {
      expect(await runOf(id)).toEqual({
        agent_public_id: 'agent_live',
        definition: {
          scorers: [{ type: 'contains', value: 'refund' }],
          pass_threshold: 0.8,
          group_by: 'kind',
        },
      });
    }
  );

  test('an Eval without a threshold fills a definition whose threshold is null', async () => {
    expect(await runOf(4)).toEqual({
      agent_public_id: 'agent_live',
      definition: {
        scorers: [{ type: 'exact_match' }],
        pass_threshold: null,
        group_by: null,
      },
    });
  });

  test('a terminal run records neither', async () => {
    expect(await runOf(3)).toEqual({
      agent_public_id: null,
      definition: null,
    });
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
