import { buildEmbeddingModel, getEmbeddings } from 'src/lib/embedding';

// The AI SDK's returned EmbeddingModel exposes `modelId` and `config.provider`
// regardless of provider, plus (for the OpenAI-compatible builder) a
// `config.url` function that resolves the actual request endpoint — enough to
// assert the model string and base URL wiring landed correctly, instead of
// only checking that `buildEmbeddingModel` didn't throw. This mirrors how
// `buildModel` is tested in `agentModel.test.ts`.

const asConfigured = (model: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return model as any;
};

describe('buildEmbeddingModel', () => {
  test('throws for an unsupported provider', () => {
    expect(() => {
      buildEmbeddingModel({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: 'cohere' as any,
        model: 'embed-english-v3',
      });
    }).toThrow(/Unsupported embedding provider: cohere/);
  });

  test('builds an ollama embedding model wired to the local /v1 endpoint', () => {
    const model = asConfigured(
      buildEmbeddingModel({
        provider: 'ollama',
        model: 'qwen3-embedding:0.6b',
      })
    );
    expect(model.modelId).toBe('qwen3-embedding:0.6b');
    expect(
      model.config.url({
        path: '/embeddings',
        modelId: 'qwen3-embedding:0.6b',
      })
    ).toBe('http://localhost:11434/v1/embeddings');
  });

  test('builds an openai embedding model wired to the default endpoint', () => {
    // The suite sets EMBEDDING_BASE_URL to a local stub; clear it here to
    // assert the default OpenAI endpoint wiring.
    const prev = process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_BASE_URL;
    try {
      const model = asConfigured(
        buildEmbeddingModel({
          provider: 'openai',
          model: 'text-embedding-3-small',
        })
      );
      expect(model.modelId).toBe('text-embedding-3-small');
      expect(model.config.provider).toBe('openai.embedding');
      expect(
        model.config.url({
          path: '/embeddings',
          modelId: 'text-embedding-3-small',
        })
      ).toBe('https://api.openai.com/v1/embeddings');
    } finally {
      if (prev === undefined) {
        delete process.env.EMBEDDING_BASE_URL;
      } else {
        process.env.EMBEDDING_BASE_URL = prev;
      }
    }
  });

  test('builds an openai-compatible embedding model at EMBEDDING_BASE_URL', () => {
    const prev = process.env.EMBEDDING_BASE_URL;
    process.env.EMBEDDING_BASE_URL = 'https://compat.example.com/v1';
    try {
      const model = asConfigured(
        buildEmbeddingModel({
          provider: 'openai',
          model: 'bge-m3',
        })
      );
      expect(model.config.url({ path: '/embeddings', modelId: 'bge-m3' })).toBe(
        'https://compat.example.com/v1/embeddings'
      );
    } finally {
      if (prev === undefined) {
        delete process.env.EMBEDDING_BASE_URL;
      } else {
        process.env.EMBEDDING_BASE_URL = prev;
      }
    }
  });

  test('builds a bedrock embedding model with the requested model id and region', () => {
    const prev = process.env.EMBEDDING_REGION;
    process.env.EMBEDDING_REGION = 'us-west-2';
    try {
      const model = asConfigured(
        buildEmbeddingModel({
          provider: 'bedrock',
          model: 'amazon.titan-embed-text-v2:0',
        })
      );
      expect(model.modelId).toBe('amazon.titan-embed-text-v2:0');
      expect(model.provider).toBe('amazon-bedrock');
      expect(model.config.baseUrl()).toBe(
        'https://bedrock-runtime.us-west-2.amazonaws.com'
      );
    } finally {
      if (prev === undefined) {
        delete process.env.EMBEDDING_REGION;
      } else {
        process.env.EMBEDDING_REGION = prev;
      }
    }
  });
});

describe('getEmbeddings', () => {
  test('throws when EMBEDDING_PROVIDER is unset', async () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    try {
      await expect(getEmbeddings({ texts: ['hello'] })).rejects.toThrow(
        /EMBEDDING_PROVIDER and EMBEDDING_MODEL/
      );
    } finally {
      process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  test('throws for an unsupported provider', async () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = 'cohere';
    try {
      await expect(getEmbeddings({ texts: ['hello'] })).rejects.toThrow(
        /Unsupported embedding provider: cohere/
      );
    } finally {
      process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  test('returns one vector per input for the configured provider', async () => {
    const embeddings = await getEmbeddings({ texts: ['alpha', 'beta'] });
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(
      Number(process.env.EMBEDDING_DIMENSIONS)
    );
    expect(embeddings[1]).toHaveLength(
      Number(process.env.EMBEDDING_DIMENSIONS)
    );
  });
});
