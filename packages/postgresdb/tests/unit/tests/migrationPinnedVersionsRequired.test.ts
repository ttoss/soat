import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import { createDatabase, dropDatabase, selectRows } from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_pinned_versions_required_${process.pid}`;
const NAME = '2026-11-24-pinned-versions-required';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const isNullable = async (args: {
  client: Sequelize;
  table: string;
  column: string;
}) => {
  const rows = await selectRows<{ is_nullable: string }>({
    client: args.client,
    sql: `SELECT is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = '${args.table}'
             AND column_name = '${args.column}'`,
  });
  return rows[0]?.is_nullable;
};

afterAll(async () => {
  await dropDatabase(DATABASE);
});

describe(NAME, () => {
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE orchestrations (id serial PRIMARY KEY, version integer NOT NULL);
      CREATE TABLE orchestration_runs (
        id serial PRIMARY KEY,
        orchestration_id integer NOT NULL REFERENCES orchestrations (id),
        orchestration_version integer
      );
      CREATE TABLE workflows (id serial PRIMARY KEY, version integer NOT NULL);
      CREATE TABLE tasks (
        id serial PRIMARY KEY,
        workflow_id integer NOT NULL REFERENCES workflows (id),
        workflow_version integer
      );
      INSERT INTO orchestrations (version) VALUES (4);
      INSERT INTO orchestration_runs (orchestration_id, orchestration_version)
        VALUES (1, NULL), (1, 2);
      INSERT INTO workflows (version) VALUES (7);
      INSERT INTO tasks (workflow_id, workflow_version) VALUES (1, NULL), (1, 3);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('pins an unpinned run to its orchestration version and requires it', async () => {
    expect(
      await selectRows<{ orchestration_version: number }>({
        client,
        sql: 'SELECT orchestration_version FROM orchestration_runs ORDER BY id',
      })
    ).toEqual([{ orchestration_version: 4 }, { orchestration_version: 2 }]);
    expect(
      await isNullable({
        client,
        table: 'orchestration_runs',
        column: 'orchestration_version',
      })
    ).toBe('NO');
  });

  test('pins an unpinned task to its workflow version and requires it', async () => {
    expect(
      await selectRows<{ workflow_version: number }>({
        client,
        sql: 'SELECT workflow_version FROM tasks ORDER BY id',
      })
    ).toEqual([{ workflow_version: 7 }, { workflow_version: 3 }]);
    expect(
      await isNullable({ client, table: 'tasks', column: 'workflow_version' })
    ).toBe('NO');
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
