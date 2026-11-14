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

const DATABASE = `soat_migration_eval_run_evidence_${process.pid}`;
const NAME = '2026-11-14-eval-run-evidence';

beforeAll(async () => {
  await startDatabaseServer();
});

afterAll(async () => {
  await dropDatabase(DATABASE);
  await stopDatabaseServer();
});

describe(NAME, () => {
  let client: Sequelize;

  type RunRow = {
    public_id: string;
    agent_public_id: string | null;
    definition: unknown;
  };

  const runOf = async (publicId: string): Promise<RunRow> => {
    const [row] = await selectRows<RunRow>({
      client,
      sql: `SELECT public_id, agent_public_id, definition FROM eval_runs WHERE public_id = '${publicId}'`,
    });
    return row;
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE agents (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL
      );
      CREATE TABLE evals (
        id serial PRIMARY KEY,
        agent_id integer NOT NULL REFERENCES agents (id),
        scorers json NOT NULL,
        pass_threshold decimal,
        group_by varchar(255)
      );
      CREATE TABLE eval_runs (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        eval_id integer NOT NULL REFERENCES evals (id),
        status varchar(255) NOT NULL
      );

      INSERT INTO agents (public_id) VALUES ('agent_AAAAAAAAAAAAAAAA');
      INSERT INTO evals (agent_id, scorers, pass_threshold, group_by)
        VALUES (1, '[{"value": "ok", "type": "contains"}]', 0.8, 'kind');
      INSERT INTO eval_runs (public_id, eval_id, status) VALUES
        ('evrun_queuedAAAAAAAAA', 1, 'queued'),
        ('evrun_runningAAAAAAAA', 1, 'running'),
        ('evrun_completedAAAAAA', 1, 'completed');
    `);

    await createMigrationRunner({
      migrations: MIGRATIONS,
      sequelize: client,
      log: () => {
        return undefined;
      },
    }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('adds the columns as their models declare them', async () => {
    expect(
      await columnType({ client, table: 'evals', column: 'evidence' })
    ).toBe('json');
    expect(
      await columnType({ client, table: 'eval_runs', column: 'definition' })
    ).toBe('json');
    expect(
      await columnType({ client, table: 'eval_runs', column: 'verdict' })
    ).toBe('character varying');
  });

  test('a live run receives its eval agent and grading fields', async () => {
    for (const publicId of ['evrun_queuedAAAAAAAAA', 'evrun_runningAAAAAAAA']) {
      const run = await runOf(publicId);
      expect(run.agent_public_id).toBe('agent_AAAAAAAAAAAAAAAA');
      expect(run.definition).toEqual({
        scorers: [{ value: 'ok', type: 'contains' }],
        pass_threshold: 0.8,
        group_by: 'kind',
        evidence: null,
      });
    }
  });

  test('keeps the scorers key order as written', async () => {
    const [row] = await selectRows<{ scorers: string }>({
      client,
      sql: `SELECT (definition -> 'scorers')::text AS scorers FROM eval_runs WHERE public_id = 'evrun_queuedAAAAAAAAA'`,
    });
    expect(row.scorers.indexOf('value')).toBeLessThan(
      row.scorers.indexOf('type')
    );
  });

  test('a settled run is left without a definition', async () => {
    const run = await runOf('evrun_completedAAAAAA');
    expect(run.agent_public_id).toBeNull();
    expect(run.definition).toBeNull();
  });
});
