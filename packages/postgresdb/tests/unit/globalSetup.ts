import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

declare global {
  var soatPostgresdbTestContainer: StartedPostgreSqlContainer | undefined;
}

/**
 * One PostgreSQL for the run; every suite creates databases of its own on it.
 * `TEST_DB_HOST` reuses a running server instead. Workers fork after this
 * returns, so they inherit the `TEST_DB_*` it writes.
 */
const globalSetup = async () => {
  if (process.env.TEST_DB_HOST) {
    return;
  }

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(
    'pgvector/pgvector:0.8.2-pg18-trixie'
  ).start();

  globalThis.soatPostgresdbTestContainer = container;

  process.env.TEST_DB_HOST = container.getHost();
  process.env.TEST_DB_PORT = String(container.getPort());
  process.env.TEST_DB_USERNAME = container.getUsername();
  process.env.TEST_DB_PASSWORD = container.getPassword();
};

export default globalSetup;
