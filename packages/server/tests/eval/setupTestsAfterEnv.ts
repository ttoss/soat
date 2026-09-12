import { installEmbeddingStub } from '../unit/embeddingStub';
import { installTestDatabase } from '../unit/testDatabaseLifecycle';
import { featureHashEmbedding } from './knowledge/featureHashEmbedding';

// The whole reason this project exists. The unit suite's stub answers every
// input with the same vector, so every cosine score ties and no ranking change
// is observable; the feature hasher is deterministic, distinct per text, and
// orders by term overlap.
installEmbeddingStub({
  embed: (input) => {
    return featureHashEmbedding({
      text: input,
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS),
    });
  },
});

// Seeding the corpus embeds every chunk one HTTP call at a time.
jest.setTimeout(600000);

installTestDatabase();
