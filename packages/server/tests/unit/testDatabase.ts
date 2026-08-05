import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

/**
 * The container is started once in `globalSetup` and stopped in
 * `globalTeardown`. Those are two separate modules that Jest loads
 * independently, so the handle travels on `globalThis` — the one object both
 * are guaranteed to share — rather than through module scope.
 */
declare global {
  var soatTestPostgresContainer: StartedPostgreSqlContainer | undefined;
}

export type TestDatabaseConnection = {
  host: string;
  port: number;
  username: string;
  password: string;
};

/**
 * Schema-only database every test file is cloned from. Built once by
 * `globalSetup`; never connected to afterwards, because a session on the
 * template blocks `CREATE DATABASE ... TEMPLATE`.
 */
export const TEMPLATE_DATABASE = 'soat_test_template';

/** Maintenance database used for `CREATE`/`DROP DATABASE`, which cannot run
 * from inside the database they target. */
const ADMIN_DATABASE = 'postgres';

/**
 * PostgreSQL `object_in_use`. `CREATE DATABASE ... TEMPLATE` refuses to run
 * while any session is connected to the source, and an autovacuum worker can
 * connect to the template at any moment — brief, unpredictable, and entirely
 * transient. Retrying is the documented remedy; the alternative is a CI flake
 * with no relation to the code under test.
 */
const OBJECT_IN_USE = '55006';
const CLONE_ATTEMPTS = 5;
const CLONE_RETRY_DELAY_MS = 250;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
};

export const withAdminClient = async <T>(args: {
  connection: TestDatabaseConnection;
  run: (client: Client) => Promise<T>;
}): Promise<T> => {
  const client = new Client({
    host: args.connection.host,
    port: args.connection.port,
    user: args.connection.username,
    password: args.connection.password,
    database: ADMIN_DATABASE,
  });

  await client.connect();

  try {
    return await args.run(client);
  } finally {
    await client.end();
  }
};

/**
 * Publish the connection so worker processes can find it. Jest forks workers
 * after `globalSetup` returns, so they inherit whatever it writes to
 * `process.env`.
 */
export const publishTestDatabaseConnection = (args: {
  connection: TestDatabaseConnection;
}) => {
  process.env.SOAT_TEST_DB_HOST = args.connection.host;
  process.env.SOAT_TEST_DB_PORT = String(args.connection.port);
  process.env.SOAT_TEST_DB_USERNAME = args.connection.username;
  process.env.SOAT_TEST_DB_PASSWORD = args.connection.password;
};

export const readTestDatabaseConnection = (): TestDatabaseConnection => {
  const host = process.env.SOAT_TEST_DB_HOST;

  if (!host) {
    throw new Error(
      'SOAT_TEST_DB_HOST is unset — the test database was never published. ' +
        'Run the suite through its Jest config so globalSetup executes.'
    );
  }

  return {
    host,
    port: Number(process.env.SOAT_TEST_DB_PORT),
    username: process.env.SOAT_TEST_DB_USERNAME ?? 'postgres',
    password: process.env.SOAT_TEST_DB_PASSWORD ?? '',
  };
};

/**
 * Clone the template into a database of its own for one test file.
 *
 * This is what replaced a per-file `PostgreSqlContainer` + `sync()`: cloning
 * copies an already-built schema at the file level (tens of milliseconds)
 * instead of starting a container and re-running the DDL (seconds), while
 * giving each file exactly the same guarantee it had before — a private,
 * pristine database no other file can observe.
 */
export const createTestDatabase = async (args: {
  connection: TestDatabaseConnection;
}): Promise<string> => {
  const database = `soat_test_${randomUUID().replaceAll('-', '')}`;

  await withAdminClient({
    connection: args.connection,
    run: async (client) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.query(
            `CREATE DATABASE "${database}" TEMPLATE "${TEMPLATE_DATABASE}"`
          );
          return;
        } catch (error) {
          if (attempt >= CLONE_ATTEMPTS || errorCode(error) !== OBJECT_IN_USE) {
            throw error;
          }
          await delay(CLONE_RETRY_DELAY_MS);
        }
      }
    },
  });

  return database;
};

/**
 * `WITH (FORCE)` terminates any session still attached. The pool is closed
 * before this runs, but a connection opened by the code under test and never
 * awaited would otherwise fail the drop and turn a passing file red for a
 * teardown detail.
 */
export const dropTestDatabase = async (args: {
  connection: TestDatabaseConnection;
  database: string;
}) => {
  await withAdminClient({
    connection: args.connection,
    run: async (client) => {
      await client.query(
        `DROP DATABASE IF EXISTS "${args.database}" WITH (FORCE)`
      );
    },
  });
};
