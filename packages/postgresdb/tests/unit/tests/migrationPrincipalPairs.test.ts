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

const DATABASE = `soat_migration_principal_pairs_${process.pid}`;
const NAME = '2026-10-17-principal-pairs';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

type Pair = { type: string | null; id: string | null };

const pairsOf = async (args: {
  client: Sequelize;
  table: string;
  verb: string;
}): Promise<Pair[]> => {
  return selectRows<Pair>({
    client: args.client,
    sql: `SELECT ${args.verb}_principal_type AS type,
        ${args.verb}_principal_id AS id
      FROM ${args.table} ORDER BY ${args.table}.id`,
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

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    // `playbook_*` tables are absent: a database predating a module keeps
    // migrating the tables it has.
    await client.query(`
      CREATE TABLE users (id serial PRIMARY KEY, public_id varchar(32));
      CREATE TABLE agent_versions (
        id serial PRIMARY KEY,
        created_by_user_id integer REFERENCES users (id) ON DELETE SET NULL
      );
      CREATE TABLE approval_items (
        id serial PRIMARY KEY,
        resolved_by_user_id integer REFERENCES users (id) ON DELETE SET NULL
      );
      CREATE TABLE exception_items (
        id serial PRIMARY KEY,
        acknowledged_by_user_id integer REFERENCES users (id),
        resolved_by_user_id integer REFERENCES users (id)
      );
      CREATE TABLE task_transitions (
        id serial PRIMARY KEY,
        principal_kind varchar(255) NOT NULL,
        principal_id varchar(255)
      );

      INSERT INTO users (public_id) VALUES ('user_ana'), ('user_bob');
      INSERT INTO agent_versions (created_by_user_id) VALUES (1), (NULL), (2);
      INSERT INTO approval_items (resolved_by_user_id) VALUES (2), (NULL);
      INSERT INTO exception_items (acknowledged_by_user_id, resolved_by_user_id)
        VALUES (1, 2), (1, NULL);
      INSERT INTO task_transitions (principal_kind, principal_id)
        VALUES ('api_key', 'key_one'), ('automation', NULL);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a user id becomes a user principal; no user stays null', async () => {
    expect(
      await pairsOf({ client, table: 'agent_versions', verb: 'created_by' })
    ).toEqual([
      { type: 'user', id: 'user_ana' },
      { type: null, id: null },
      { type: 'user', id: 'user_bob' },
    ]);
    expect(
      await pairsOf({ client, table: 'approval_items', verb: 'resolved_by' })
    ).toEqual([
      { type: 'user', id: 'user_bob' },
      { type: null, id: null },
    ]);
    expect(
      await pairsOf({
        client,
        table: 'exception_items',
        verb: 'acknowledged_by',
      })
    ).toEqual([
      { type: 'user', id: 'user_ana' },
      { type: 'user', id: 'user_ana' },
    ]);
    expect(
      await pairsOf({ client, table: 'exception_items', verb: 'resolved_by' })
    ).toEqual([
      { type: 'user', id: 'user_bob' },
      { type: null, id: null },
    ]);
  });

  test('the user foreign keys are gone', async () => {
    expect(
      await columnType({
        client,
        table: 'agent_versions',
        column: 'created_by_user_id',
      })
    ).toBeUndefined();
    expect(
      await columnType({
        client,
        table: 'exception_items',
        column: 'acknowledged_by_user_id',
      })
    ).toBeUndefined();
  });

  test('a task transition keeps its principal under `principal_type`', async () => {
    expect(
      await selectRows({
        client,
        sql: `SELECT principal_type, principal_id
          FROM task_transitions ORDER BY id`,
      })
    ).toEqual([
      { principal_type: 'api_key', principal_id: 'key_one' },
      { principal_type: 'automation', principal_id: null },
    ]);
  });

  test('deleting a user keeps the principal it recorded', async () => {
    await client.query('DELETE FROM users WHERE id = 1');

    expect(
      await pairsOf({ client, table: 'agent_versions', verb: 'created_by' })
    ).toContainEqual({ type: 'user', id: 'user_ana' });
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
