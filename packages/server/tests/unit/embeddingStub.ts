import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

/**
 * A local OpenAI-compatible embedding endpoint, rather than a mock of the
 * non-configurable `ai` exports — which would collide with the generation
 * tests' own `ai` mocks. It also exercises the real request serialization.
 *
 * `embed` is the whole variation between suites: the unit suite returns one
 * constant vector (nothing there ranks), the retrieval eval returns a
 * feature-hashed vector (where ranking is the thing under test).
 */

// One "token" per whitespace-separated word, so metering assertions have a
// non-zero, deterministic count to read (a real provider reports its own).
const countStubTokens = (inputs: Array<string | undefined>): number => {
  return inputs.reduce((total, input) => {
    const words = (input ?? '').trim().split(/\s+/).filter(Boolean);
    return total + words.length;
  }, 0);
};

const embeddingResponse = (args: {
  body: { input?: string | string[]; model?: string };
  embed: (input: string) => number[];
}) => {
  const inputs = Array.isArray(args.body.input)
    ? args.body.input
    : [args.body.input];
  const data = inputs.map((input, index) => {
    return { object: 'embedding', index, embedding: args.embed(input ?? '') };
  });
  const promptTokens = countStubTokens(inputs);
  return {
    object: 'list',
    model: args.body.model ?? 'test-embedding',
    data,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
};

const handleEmbeddingRequest = (args: {
  req: IncomingMessage;
  res: ServerResponse;
  embed: (input: string) => number[];
}) => {
  let raw = '';
  args.req.on('data', (chunk) => {
    raw += chunk;
  });
  args.req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    args.res.setHeader('content-type', 'application/json');
    args.res.end(
      JSON.stringify(embeddingResponse({ body, embed: args.embed }))
    );
  });
};

/**
 * Registers the stub's lifecycle on the surrounding suite and points
 * `EMBEDDING_BASE_URL` at it. Called from a `setupFilesAfterEnv` module, so the
 * hooks apply to every test file the project runs.
 */
export const installEmbeddingStub = (args: {
  embed: (input: string) => number[];
}) => {
  let embeddingServer: Server;

  beforeAll(async () => {
    embeddingServer = createServer((req, res) => {
      handleEmbeddingRequest({ req, res, embed: args.embed });
    });

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
};
