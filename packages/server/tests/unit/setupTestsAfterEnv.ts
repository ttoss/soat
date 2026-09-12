import type { Sequelize } from '@ttoss/postgresdb';
import * as agentGenerationModule from 'src/lib/agentGeneration';

import { installEmbeddingStub } from './embeddingStub';
import { installTestDatabase } from './testDatabaseLifecycle';

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

// The unit suite asserts on *how* embeddings are stored and metered, never on
// how they rank, so one constant vector for every input is exactly right here —
// it keeps the fixtures free of vector noise. The retrieval eval installs the
// same stub with a discriminating embedder instead.
installEmbeddingStub({
  embed: () => {
    return Array(Number(process.env.EMBEDDING_DIMENSIONS)).fill(0.1);
  },
});

export let sequelize: Sequelize;

jest.setTimeout(120000);

/**
 * Each test file gets a private database cloned from the template `globalSetup`
 * built — the same isolation a per-file container gave, without paying for a
 * container start and a schema `sync()` 167 times over.
 */
installTestDatabase({
  onReady: (db) => {
    sequelize = db;
  },
});
