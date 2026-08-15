import type { Server } from 'node:http';
import { createServer } from 'node:http';

import { DomainError } from 'src/errors';
import type { BedrockCredentials } from 'src/lib/agentModel';
import type { BedrockListArgs, FetchLike } from 'src/lib/aiProviderModels';
import {
  enumerateProviderModels,
  isModelListingSupported,
} from 'src/lib/aiProviderModels';
import { toBedrockClientConfig } from 'src/lib/bedrockModelCatalog';

/**
 * A `fetch` stand-in. The HTTP call to a model provider is the one boundary
 * these tests fake: it is external I/O that cannot run in CI, and every line
 * worth asserting here — which URL is called, which auth header carries the
 * credential, how a provider's payload maps onto our shape — is on this side
 * of it.
 */
const fakeFetch = (
  responses: Record<string, { status?: number; body: unknown }>
): { fetchImpl: FetchLike; calls: { url: string; headers: Headers }[] } => {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    const match = Object.keys(responses).find((key) => {
      return url.startsWith(key);
    });
    if (!match) {
      return Promise.reject(new Error(`unexpected request to ${url}`));
    }
    const response = responses[match];
    return Promise.resolve({
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      text: () => {
        return Promise.resolve(JSON.stringify(response.body));
      },
    });
  };
  return { fetchImpl, calls };
};

describe('enumerateProviderModels — against a real HTTP server', () => {
  // No `fetchImpl` here: this drives the module's own default, so real `fetch`,
  // real request serialization and real header delivery are exercised end to
  // end. A faked seam would skip all three.
  let server: Server;
  let baseUrl: string;
  let seenAuthorization: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenAuthorization = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ data: [{ id: 'local-model', owned_by: 'me' }] })
      );
    });
    await new Promise<void>((resolve) => {
      return server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected an assigned TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      return server.close((error) => {
        return error ? reject(error) : resolve();
      });
    });
  });

  test('lists models over real HTTP, sending the credential as a Bearer token', async () => {
    const models = await enumerateProviderModels({
      provider: 'custom',
      baseUrl,
      secretValue: 'sk-local',
    });

    expect(seenAuthorization).toBe('Bearer sk-local');
    expect(models).toEqual([
      { id: 'local-model', vendor: 'me', streaming: true },
    ]);
  });
});

describe('isModelListingSupported', () => {
  test('reports the slugs that can enumerate models', () => {
    expect(isModelListingSupported('bedrock')).toBe(true);
    expect(isModelListingSupported('vertex')).toBe(true);
    expect(isModelListingSupported('openai')).toBe(true);
    expect(isModelListingSupported('anthropic')).toBe(true);
  });

  test('reports the slugs that cannot', () => {
    // Ollama serves whatever the operator pulled locally and azure lists
    // deployments rather than models; neither answers "what can I run".
    expect(isModelListingSupported('azure')).toBe(false);
  });
});

describe('enumerateProviderModels — openai-compatible', () => {
  test('lists models from /models and maps the payload', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://api.openai.com/v1/models': {
        body: {
          data: [
            { id: 'gpt-4o-mini', owned_by: 'openai' },
            { id: 'gpt-4o', owned_by: 'openai' },
          ],
        },
      },
    });

    const models = await enumerateProviderModels({
      provider: 'openai',
      secretValue: 'sk-test',
      fetchImpl,
    });

    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-test');
    expect(models).toEqual([
      { id: 'gpt-4o-mini', vendor: 'openai', streaming: true },
      { id: 'gpt-4o', vendor: 'openai', streaming: true },
    ]);
  });

  test('honours base_url so a gateway or self-hosted endpoint is reachable', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://gateway.internal/v1/models': { body: { data: [] } },
    });

    await enumerateProviderModels({
      provider: 'gateway',
      baseUrl: 'https://gateway.internal/v1',
      secretValue: 'sk-test',
      fetchImpl,
    });

    expect(calls[0].url).toBe('https://gateway.internal/v1/models');
  });

  test('surfaces an upstream rejection as a listing failure', async () => {
    const { fetchImpl } = fakeFetch({
      'https://api.openai.com/v1/models': {
        status: 401,
        body: { error: { message: 'invalid api key' } },
      },
    });

    await expect(
      enumerateProviderModels({
        provider: 'openai',
        secretValue: 'sk-bad',
        fetchImpl,
      })
    ).rejects.toThrow(DomainError);
  });
});

describe('enumerateProviderModels — anthropic', () => {
  test('authenticates with x-api-key and keeps the display name', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://api.anthropic.com/v1/models': {
        body: {
          data: [
            {
              id: 'claude-sonnet-4-5',
              display_name: 'Claude Sonnet 4.5',
              created_at: '2026-01-05T00:00:00Z',
            },
          ],
        },
      },
    });

    const models = await enumerateProviderModels({
      provider: 'anthropic',
      secretValue: 'sk-ant-test',
      fetchImpl,
    });

    // Anthropic authenticates on its own header, not Bearer; sending the wrong
    // one yields a 401 that reads like a bad credential rather than a bug here.
    expect(calls[0].headers.get('x-api-key')).toBe('sk-ant-test');
    expect(calls[0].headers.get('anthropic-version')).toBeTruthy();
    expect(models).toEqual([
      {
        id: 'claude-sonnet-4-5',
        display_name: 'Claude Sonnet 4.5',
        vendor: 'anthropic',
        streaming: true,
      },
    ]);
  });
});

describe('enumerateProviderModels — vertex', () => {
  test('lists publisher models for the configured project and location', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://us-central1-aiplatform.googleapis.com': {
        body: {
          publisherModels: [
            {
              name: 'publishers/google/models/gemini-2.5-flash',
              versionId: '001',
              publisherModelTemplate: 'projects/x/locations/us-central1',
              launchStage: 'GA',
            },
          ],
        },
      },
    });

    const models = await enumerateProviderModels({
      provider: 'vertex',
      config: { project: 'naturali-504614', location: 'us-central1' },
      accessTokenProvider: () => {
        return Promise.resolve('ya29.test');
      },
      fetchImpl,
    });

    expect(calls[0].headers.get('authorization')).toBe('Bearer ya29.test');
    expect(models).toEqual([
      {
        id: 'gemini-2.5-flash',
        vendor: 'google',
        streaming: true,
        lifecycle: 'active',
      },
    ]);
  });

  test('marks a deprecated launch stage so the catalog can retire it', async () => {
    const { fetchImpl } = fakeFetch({
      'https://us-central1-aiplatform.googleapis.com': {
        body: {
          publisherModels: [
            {
              name: 'publishers/google/models/gemini-1.5-flash-002',
              launchStage: 'DEPRECATED',
            },
          ],
        },
      },
    });

    const models = await enumerateProviderModels({
      provider: 'vertex',
      config: { project: 'p', location: 'us-central1' },
      accessTokenProvider: () => {
        return Promise.resolve('ya29.test');
      },
      fetchImpl,
    });

    expect(models[0].lifecycle).toBe('deprecated');
  });

  test('defaults the location the same way model building does', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://us-central1-aiplatform.googleapis.com': {
        body: { publisherModels: [] },
      },
    });

    await enumerateProviderModels({
      provider: 'vertex',
      config: { project: 'p' },
      accessTokenProvider: () => {
        return Promise.resolve('ya29.test');
      },
      fetchImpl,
    });

    expect(calls[0].url).toContain('us-central1-aiplatform.googleapis.com');
  });

  test('refuses to guess when no project is configured', async () => {
    await expect(
      enumerateProviderModels({
        provider: 'vertex',
        config: {},
        accessTokenProvider: () => {
          return Promise.resolve('ya29.test');
        },
        fetchImpl: fakeFetch({}).fetchImpl,
      })
    ).rejects.toThrow(DomainError);
  });
});

describe('enumerateProviderModels — bedrock', () => {
  test('maps foundation models, including the inference-profile prefix', async () => {
    const models = await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'us-east-1' },
      listFoundationModels: () => {
        return Promise.resolve([
          {
            modelId: 'anthropic.claude-sonnet-4-5-20260101-v1:0',
            modelName: 'Claude Sonnet 4.5',
            providerName: 'Anthropic',
            inputModalities: ['TEXT', 'IMAGE'],
            outputModalities: ['TEXT'],
            responseStreamingSupported: true,
            modelLifecycle: { status: 'ACTIVE' },
            inferenceTypesSupported: ['INFERENCE_PROFILE'],
          },
        ]);
      },
    });

    expect(models).toEqual([
      {
        id: 'anthropic.claude-sonnet-4-5-20260101-v1:0',
        display_name: 'Claude Sonnet 4.5',
        vendor: 'Anthropic',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        streaming: true,
        lifecycle: 'active',
        inference_types: ['inference_profile'],
      },
    ]);
  });

  test('reports a legacy lifecycle so the catalog can flag a sunset model', async () => {
    const models = await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'us-east-1' },
      listFoundationModels: () => {
        return Promise.resolve([
          {
            modelId: 'amazon.titan-text-lite-v1',
            modelLifecycle: { status: 'LEGACY' },
          },
        ]);
      },
    });

    expect(models[0].lifecycle).toBe('legacy');
  });

  test('passes the configured region through to the AWS call', async () => {
    let seenRegion: string | undefined;
    await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'sa-east-1' },
      listFoundationModels: (args) => {
        seenRegion = args.region;
        return Promise.resolve([]);
      },
    });

    expect(seenRegion).toBe('sa-east-1');
  });
});

describe('enumerateProviderModels — google ai studio', () => {
  test('strips the models/ prefix and reads streaming from the method list', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://generativelanguage.googleapis.com': {
        body: {
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              supportedGenerationMethods: [
                'generateContent',
                'streamGenerateContent',
              ],
            },
            {
              name: 'models/text-embedding-004',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        },
      },
    });

    const models = await enumerateProviderModels({
      provider: 'google',
      secretValue: 'AIza-test',
      fetchImpl,
    });

    expect(calls[0].headers.get('x-goog-api-key')).toBe('AIza-test');
    expect(models).toEqual([
      {
        id: 'gemini-2.5-flash',
        display_name: 'Gemini 2.5 Flash',
        vendor: 'google',
        streaming: true,
      },
      { id: 'text-embedding-004', vendor: 'google', streaming: false },
    ]);
  });
});

describe('enumerateProviderModels — malformed payloads', () => {
  test('skips entries with no usable id rather than inventing one', async () => {
    const { fetchImpl } = fakeFetch({
      'https://api.openai.com/v1/models': {
        body: { data: [{ owned_by: 'openai' }, { id: 'gpt-4o' }, 'nonsense'] },
      },
    });

    const models = await enumerateProviderModels({
      provider: 'openai',
      secretValue: 'sk-test',
      fetchImpl,
    });

    // No `owned_by` on the surviving entry, so no vendor is invented for it.
    expect(models).toEqual([{ id: 'gpt-4o', streaming: true }]);
  });

  test('treats a non-JSON body as a listing failure', async () => {
    const fetchImpl: FetchLike = () => {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => {
          return Promise.resolve('<html>gateway timeout</html>');
        },
      });
    };

    await expect(
      enumerateProviderModels({
        provider: 'openai',
        secretValue: 'sk-test',
        fetchImpl,
      })
    ).rejects.toThrow(DomainError);
  });

  test('tolerates a payload with no list at all', async () => {
    const { fetchImpl } = fakeFetch({
      'https://api.anthropic.com/v1/models': { body: {} },
    });

    await expect(
      enumerateProviderModels({
        provider: 'anthropic',
        secretValue: 'sk-ant-test',
        fetchImpl,
      })
    ).resolves.toEqual([]);
  });
});

describe('toBedrockClientConfig', () => {
  // The AWS client is constructed behind a lazy import that cannot run in CI,
  // so this branch — which decides how the request is *signed* — is asserted
  // directly. Getting it wrong fails at AWS with a signing error, not here.
  test('sends a Bedrock API key as a bearer token, not as credentials', () => {
    expect(
      toBedrockClientConfig({
        region: 'us-east-1',
        credentials: { region: 'us-east-1', apiKey: 'ABSKexample' },
      })
    ).toEqual({ region: 'us-east-1', token: { token: 'ABSKexample' } });
  });

  test('sends static IAM keys as credentials for SigV4', () => {
    expect(
      toBedrockClientConfig({
        region: 'eu-west-1',
        credentials: {
          region: 'eu-west-1',
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'shh',
          sessionToken: 'tok',
        },
      })
    ).toEqual({
      region: 'eu-west-1',
      credentials: {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'shh',
        sessionToken: 'tok',
      },
    });
  });

  test('passes the ambient provider through when no secret selected one', () => {
    const credentialProvider = (() => {
      return Promise.resolve({ accessKeyId: 'a', secretAccessKey: 'b' });
    }) as Extract<
      BedrockCredentials,
      { credentialProvider: unknown }
    >['credentialProvider'];

    expect(
      toBedrockClientConfig({
        region: 'us-east-1',
        credentials: { region: 'us-east-1', credentialProvider },
      })
    ).toEqual({ region: 'us-east-1', credentials: credentialProvider });
  });
});

describe('enumerateProviderModels — listing honors the linked secret (#1044)', () => {
  test('bedrock signs the control-plane call with the secret IAM credentials', async () => {
    let seen: BedrockListArgs | undefined;
    await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'us-east-1' },
      secretValue: JSON.stringify({
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'shh',
        sessionToken: 'tok',
      }),
      listFoundationModels: (args) => {
        seen = args;
        return Promise.resolve([]);
      },
    });

    // Generation signs with these; listing used to ignore them and fall through
    // to the ambient chain, so a correctly-configured record could not list.
    expect(seen?.credentials).toEqual({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'shh',
      sessionToken: 'tok',
    });
  });

  test('bedrock carries a Bedrock API key as a bearer token', async () => {
    let seen: BedrockListArgs | undefined;
    await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'us-east-1' },
      secretValue: 'ABSKexample',
      listFoundationModels: (args) => {
        seen = args;
        return Promise.resolve([]);
      },
    });

    expect(seen?.credentials).toEqual({
      region: 'us-east-1',
      apiKey: 'ABSKexample',
    });
  });

  test('bedrock still falls back to the ambient chain with no secret', async () => {
    let seen: BedrockListArgs | undefined;
    await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'us-east-1' },
      listFoundationModels: (args) => {
        seen = args;
        return Promise.resolve([]);
      },
    });

    // The credential-less catalogue record documented in the module page has to
    // keep working — that is what lets a caller browse before provisioning.
    expect(seen?.credentials).toHaveProperty('credentialProvider');
  });

  test('vertex authenticates with the linked service account', async () => {
    const { fetchImpl } = fakeFetch({
      'https://us-central1-aiplatform.googleapis.com': {
        body: { publisherModels: [] },
      },
    });
    let seenOptions: unknown;

    await enumerateProviderModels({
      provider: 'vertex',
      config: { project: 'p' },
      secretValue: JSON.stringify({
        client_email: 'vertex@example.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
        project_id: 'from-key-file',
      }),
      accessTokenProvider: (args) => {
        seenOptions = args?.googleAuthOptions;
        return Promise.resolve('ya29.test');
      },
      fetchImpl,
    });

    expect(seenOptions).toEqual({
      credentials: {
        client_email: 'vertex@example.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
      },
    });
  });

  test('vertex takes the project from the service-account key file', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://us-central1-aiplatform.googleapis.com': {
        body: { publisherModels: [] },
      },
    });

    // Generation resolves `config.project ?? secret.project_id`, so a record
    // carrying only a key file generates fine. Listing used to throw here.
    await enumerateProviderModels({
      provider: 'vertex',
      config: {},
      secretValue: JSON.stringify({
        client_email: 'vertex@example.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
        project_id: 'from-key-file',
      }),
      accessTokenProvider: () => {
        return Promise.resolve('ya29.test');
      },
      fetchImpl,
    });

    expect(calls[0].url).toContain('/projects/from-key-file/');
  });

  test('vertex express mode cannot list, and says so', async () => {
    // Express mode targets a global, project-less endpoint; the publisher-model
    // listing URL is per-project, so there is nothing to call. Failing with a
    // named reason beats a confusing 404 from a guessed URL.
    await expect(
      enumerateProviderModels({
        provider: 'vertex',
        config: {},
        secretValue: 'AIzaExpressKey',
        fetchImpl: fakeFetch({}).fetchImpl,
      })
    ).rejects.toThrow(DomainError);
  });
});

describe('enumerateProviderModels — credentials and region', () => {
  test('refuses to call a provider with no API key linked', async () => {
    await expect(
      enumerateProviderModels({
        provider: 'openai',
        secretValue: null,
        fetchImpl: fakeFetch({}).fetchImpl,
      })
    ).rejects.toThrow(DomainError);
  });

  test('falls back to AWS_REGION when the provider config names none', async () => {
    const previous = process.env.AWS_REGION;
    process.env.AWS_REGION = 'eu-west-1';
    try {
      let seenRegion: string | undefined;
      await enumerateProviderModels({
        provider: 'bedrock',
        listFoundationModels: (args) => {
          seenRegion = args.region;
          return Promise.resolve([]);
        },
      });
      expect(seenRegion).toBe('eu-west-1');
    } finally {
      if (previous === undefined) {
        delete process.env.AWS_REGION;
      } else {
        process.env.AWS_REGION = previous;
      }
    }
  });

  test('refuses to guess a Bedrock region', async () => {
    const region = process.env.AWS_REGION;
    const defaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      await expect(
        enumerateProviderModels({
          provider: 'bedrock',
          listFoundationModels: () => {
            return Promise.resolve([]);
          },
        })
      ).rejects.toThrow(DomainError);
    } finally {
      if (region !== undefined) process.env.AWS_REGION = region;
      if (defaultRegion !== undefined) {
        process.env.AWS_DEFAULT_REGION = defaultRegion;
      }
    }
  });

  test('omits fields a Bedrock summary does not report', async () => {
    const models = await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'us-east-1' },
      listFoundationModels: () => {
        return Promise.resolve([
          { modelId: 'amazon.titan-embed-text-v2:0' },
          { modelName: 'no id at all' },
        ]);
      },
    });

    expect(models).toEqual([
      { id: 'amazon.titan-embed-text-v2:0', lifecycle: 'active' },
    ]);
  });

  test('reports a deprecated Bedrock lifecycle', async () => {
    const models = await enumerateProviderModels({
      provider: 'bedrock',
      config: { region: 'us-east-1' },
      listFoundationModels: () => {
        return Promise.resolve([
          {
            modelId: 'amazon.titan-text-express-v1',
            modelLifecycle: { status: 'DEPRECATED' },
            responseStreamingSupported: false,
          },
        ]);
      },
    });

    expect(models[0]).toEqual({
      id: 'amazon.titan-text-express-v1',
      streaming: false,
      lifecycle: 'deprecated',
    });
  });

  test('trims a trailing slash off a configured base_url', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://gateway.internal/v1/models': { body: { data: [] } },
    });

    await enumerateProviderModels({
      provider: 'custom',
      baseUrl: 'https://gateway.internal/v1/',
      secretValue: 'sk-test',
      fetchImpl,
    });

    expect(calls[0].url).toBe('https://gateway.internal/v1/models');
  });
});

describe('enumerateProviderModels — unsupported', () => {
  test('rejects a provider that cannot enumerate models', async () => {
    await expect(
      enumerateProviderModels({ provider: 'azure', secretValue: 'k' })
    ).rejects.toThrow(DomainError);
  });

  test('rejects ollama, whose model list is whatever that host pulled', async () => {
    await expect(
      enumerateProviderModels({ provider: 'ollama' })
    ).rejects.toThrow(DomainError);
  });
});
