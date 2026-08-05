import {
  readTestDatabaseConnection,
  TEMPLATE_DATABASE,
  withAdminClient,
} from './testDatabase';

const globalTeardown = async () => {
  const container = globalThis.soatTestPostgresContainer;

  if (container) {
    globalThis.soatTestPostgresContainer = undefined;
    // Stopping the container discards the template with it.
    await container.stop();
    return;
  }

  // An external server outlives the run, so clean up after ourselves. Per-file
  // databases are dropped by their own `afterAll`; only the template is left.
  await withAdminClient({
    connection: readTestDatabaseConnection(),
    run: async (client) => {
      await client.query(
        `DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`
      );
    },
  });
};

export default globalTeardown;
