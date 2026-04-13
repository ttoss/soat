jest.mock('ollama', () => {
  return {
    Ollama: jest.fn().mockImplementation(() => {
      return {
        embed: jest.fn().mockResolvedValue({
          embeddings: [Array(1024).fill(0.1)],
        }),
        chat: jest.fn().mockResolvedValue(
          (async function* () {
            yield { message: { content: 'mock', role: 'assistant' } };
          })()
        ),
      };
    }),
  };
});

import { models } from '@soat/postgresdb';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sequelize } from '@ttoss/postgresdb';
import { initialize } from '@ttoss/postgresdb';
import { app } from 'src/app';
import { initializeDatabase } from 'src/db';

let sequelize: Sequelize;
let postgresContainer: StartedPostgreSqlContainer;

jest.setTimeout(120000);

beforeAll(async () => {
  postgresContainer = await new PostgreSqlContainer(
    'pgvector/pgvector:0.8.1-pg18-trixie'
  ).start();

  try {
    const db = await initialize({
      models,
      logging: false,
      username: postgresContainer.getUsername(),
      password: postgresContainer.getPassword(),
      database: postgresContainer.getDatabase(),
      host: postgresContainer.getHost(),
      port: postgresContainer.getPort(),
    });

    await initializeDatabase(app);

    sequelize = db.sequelize;

    await sequelize.sync();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error during database initialization:', error);
    throw error;
  }
});

afterAll(async () => {
  await sequelize?.close();
  await postgresContainer?.stop();
});
