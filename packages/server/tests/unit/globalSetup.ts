import {
  createTemplateDatabaseName,
  publishTestDatabaseConnection,
  type TestDatabaseConnection,
  withAdminClient,
} from './testDatabase';
import { applyTestEnv } from './testEnv';

const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.2-pg18-trixie';

/**
 * One PostgreSQL for the whole run. `TEST_DB_HOST` reuses an already-running
 * server instead — useful where Docker is unavailable. The account it names
 * needs `CREATEDB`, since every test file gets a database of its own.
 */
const startPostgres = async (): Promise<TestDatabaseConnection> => {
  if (process.env.TEST_DB_HOST) {
    return {
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT ?? 5432),
      username: process.env.TEST_DB_USERNAME ?? 'postgres',
      password: process.env.TEST_DB_PASSWORD ?? '',
    };
  }

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();

  globalThis.soatTestPostgresContainer = container;

  return {
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
  };
};

/**
 * Build the schema once, into a database no test ever connects to.
 *
 * The models are imported dynamically, after `applyTestEnv`, because
 * `@soat/postgresdb` reads `EMBEDDING_DIMENSIONS` at module load to size its
 * `vector` columns — a static import would be hoisted above the assignment.
 */
const buildTemplateDatabase = async (args: {
  connection: TestDatabaseConnection;
  template: string;
}) => {
  await withAdminClient({
    connection: args.connection,
    run: async (client) => {
      await client.query(`CREATE DATABASE "${args.template}"`);
    },
  });

  const { models } = await import('@soat/postgresdb');
  const { initialize } = await import('@ttoss/postgresdb');

  const db = await initialize({
    models,
    logging: false,
    createVectorExtension: true,
    ...args.connection,
    database: args.template,
  });

  await db.sequelize.sync({ force: true });

  // Every session must be gone before the first clone: PostgreSQL refuses to
  // copy a template that anyone is connected to.
  await db.sequelize.close();
};

const globalSetup = async () => {
  applyTestEnv();

  const connection = await startPostgres();

  const template = createTemplateDatabaseName();

  await buildTemplateDatabase({ connection, template });

  publishTestDatabaseConnection({ connection, template });
};

export default globalSetup;
