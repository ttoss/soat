import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { buildEmbeddingModel, getEmbeddings } from 'src/lib/embedding';

// The returned model exposes enough (`modelId`, `config.provider`, `config.url`)
// to assert the wiring landed, not just that the builder didn't throw — the same
// approach `agentModel.test.ts` takes.

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
      await expect(
        getEmbeddings({ texts: ['hello'], billing: null, subject: null })
      ).rejects.toThrow(/EMBEDDING_PROVIDER and EMBEDDING_MODEL/);
    } finally {
      process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  test('throws for an unsupported provider', async () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = 'cohere';
    try {
      await expect(
        getEmbeddings({ texts: ['hello'], billing: null, subject: null })
      ).rejects.toThrow(/Unsupported embedding provider: cohere/);
    } finally {
      process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  test('returns one vector per input for the configured provider', async () => {
    const embeddings = await getEmbeddings({
      texts: ['alpha', 'beta'],
      billing: null,
      subject: null,
    });
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(
      Number(process.env.EMBEDDING_DIMENSIONS)
    );
    expect(embeddings[1]).toHaveLength(
      Number(process.env.EMBEDDING_DIMENSIONS)
    );
  });
});

// A batch past the provider's per-call limit is several provider calls, each
// billed on its own. No route reaches one with the stub's 2048-value limit
// (`POST /embeddings` takes 256), so the batch is driven here.
describe('getEmbeddings — a batch whose later call fails', () => {
  const PER_CALL = 2048;
  let stub: Server;
  let previousBaseUrl: string | undefined;
  let projectId: number;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const inputs = (JSON.parse(raw) as { input: string[] }).input;
        res.setHeader('content-type', 'application/json');
        if (inputs.includes('poison')) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'refused' } }));
          return;
        }
        res.end(
          JSON.stringify({
            object: 'list',
            data: inputs.map((_input, index) => {
              return { object: 'embedding', index, embedding: [0.1] };
            }),
            usage: {
              prompt_tokens: inputs.length,
              total_tokens: inputs.length,
            },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, '127.0.0.1', resolve);
    });
    previousBaseUrl = process.env.EMBEDDING_BASE_URL;
    process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;

    const project = await db.Project.create({ name: 'Partial batch' });
    projectId = project.id as number;
  });

  afterAll(async () => {
    process.env.EMBEDDING_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve) => {
      stub.close(() => {
        resolve();
      });
    });
  });

  test('meters the calls that completed, then fails', async () => {
    const texts = [
      ...Array.from({ length: PER_CALL }, () => {
        return 'word';
      }),
      'poison',
    ];

    await expect(
      getEmbeddings({
        texts,
        billing: { projectId, generationId: null },
        subject: null,
      })
    ).rejects.toThrow();

    const events = await db.UsageEvent.findAll({
      where: { projectId, source: 'embedding' },
    });
    expect(events).toHaveLength(1);
    const components = await db.UsageComponent.findAll({
      where: { usageEventId: events[0].id },
    });
    expect(
      components.map((component) => {
        return [component.component, Number(component.quantity)];
      })
    ).toEqual([['input_tokens', PER_CALL]]);
  });
});
