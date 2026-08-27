import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { models } from '@soat/postgresdb';
import type { Sequelize } from '@ttoss/postgresdb';
import { initialize } from '@ttoss/postgresdb';
import { app } from 'src/app';
import { initializeDatabase } from 'src/db';
import * as agentGenerationModule from 'src/lib/agentGeneration';

import {
  createTestDatabase,
  dropTestDatabase,
  readTestDatabaseConnection,
} from './testDatabase';

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

// Spies on the module that *defines* `createGeneration`. It used to name
// `src/lib/agents`, which only re-exported it; that barrel closed three import
// cycles and is gone (#911), and pointing the spy at the definition is what
// every caller now imports anyway.
export const mockCreateGeneration = jest.spyOn(
  agentGenerationModule,
  'createGeneration'
);

// A local OpenAI-compatible stub rather than a mock of the non-configurable `ai`
// exports, which would collide with the generation tests' own `ai` mocks. This
// also exercises the real request serialization.
let embeddingServer: Server;

const embeddingResponse = (body: {
  input?: string | string[];
  model?: string;
}) => {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const vector = Array(Number(process.env.EMBEDDING_DIMENSIONS)).fill(0.1);
  const data = inputs.map((_input, index) => {
    return { object: 'embedding', index, embedding: vector };
  });
  return {
    object: 'list',
    model: body.model ?? 'test-embedding',
    data,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
};

const handleEmbeddingRequest = (req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(embeddingResponse(body)));
  });
};

beforeAll(async () => {
  embeddingServer = createServer(handleEmbeddingRequest);

  await new Promise<void>((resolve) => {
    embeddingServer.listen(0, '127.0.0.1', resolve);
  });

  const address = embeddingServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    embeddingServer.close(() => {
      resolve();
    });
  });
});

export let sequelize: Sequelize;

const connection = readTestDatabaseConnection();
let database: string | undefined;

jest.setTimeout(120000);

/**
 * Each test file gets a private database cloned from the template `globalSetup`
 * built — the same isolation a per-file container gave, without paying for a
 * container start and a schema `sync()` 167 times over.
 */
beforeAll(async () => {
  try {
    database = await createTestDatabase({ connection });

    const db = await initialize({
      models,
      logging: false,
      ...connection,
      database,
    });

    await initializeDatabase(app);

    sequelize = db.sequelize;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error during database initialization:', error);
    throw error;
  }
});

afterAll(async () => {
  await sequelize?.close();

  if (database) {
    await dropTestDatabase({ connection, database });
  }
});
