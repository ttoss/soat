import { DomainError } from 'src/errors';
import {
  buildModel,
  resolveBedrockCredentials,
  resolveVertexSettings,
} from 'src/lib/agentModel';

// The returned model exposes enough (`modelId`, `config.provider`, `config.url`)
// to assert the wiring landed, rather than only that `buildModel` didn't throw.

const asConfigured = (model: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return model as any;
};

// A GCP service-account key file, pasted verbatim as the secret value. The
// private key is a syntactically shaped placeholder — `resolveVertexSettings`
// only forwards it to google-auth-library, it never parses or signs with it.
const SERVICE_ACCOUNT_SECRET = JSON.stringify({
  type: 'service_account',
  project_id: 'sa-project',
  client_email: 'vertex@sa-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END',
});

describe('buildModel', () => {
  test('throws for unsupported provider', () => {
    expect(() => {
      buildModel({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: 'unsupported_provider' as any,
        secretValue: null,
        model: 'some-model',
      });
    }).toThrow('Unsupported AI provider: unsupported_provider');
  });

  test('builds openai model wired to the default OpenAI endpoint', () => {
    const model = asConfigured(
      buildModel({
        provider: 'openai',
        secretValue: 'test-key',
        model: 'gpt-4o',
      })
    );
    expect(model.modelId).toBe('gpt-4o');
    expect(model.config.provider).toBe('openai.responses');
    expect(model.config.url({ path: '/responses', modelId: 'gpt-4o' })).toBe(
      'https://api.openai.com/v1/responses'
    );
  });

  test('builds anthropic model with the requested model id', () => {
    const model = asConfigured(
      buildModel({
        provider: 'anthropic',
        secretValue: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      })
    );
    expect(model.modelId).toBe('claude-3-5-sonnet-20241022');
    expect(model.config.provider).toBe('anthropic.messages');
  });

  test('builds google model with the requested model id', () => {
    const model = asConfigured(
      buildModel({
        provider: 'google',
        secretValue: 'test-key',
        model: 'gemini-2.0-flash',
      })
    );
    expect(model.modelId).toBe('gemini-2.0-flash');
    expect(model.config.provider).toBe('google.generative-ai');
  });

  test('builds xai model with the requested model id', () => {
    const model = asConfigured(
      buildModel({
        provider: 'xai',
        secretValue: 'test-key',
        model: 'grok-2-latest',
      })
    );
    expect(model.modelId).toBe('grok-2-latest');
    expect(model.config.provider).toBe('xai.responses');
  });

  test('builds groq model with the requested model id', () => {
    const model = asConfigured(
      buildModel({
        provider: 'groq',
        secretValue: 'test-key',
        model: 'llama-3.3-70b-versatile',
      })
    );
    expect(model.modelId).toBe('llama-3.3-70b-versatile');
    expect(model.config.provider).toBe('groq.chat');
  });

  test('builds azure model wired to the configured resource name', () => {
    const model = asConfigured(
      buildModel({
        provider: 'azure',
        secretValue: 'test-key',
        model: 'gpt-4o',
        config: { resourceName: 'my-resource' },
      })
    );
    expect(model.modelId).toBe('gpt-4o');
    expect(model.config.url({ path: '/responses', modelId: 'gpt-4o' })).toBe(
      'https://my-resource.openai.azure.com/openai/v1/responses?api-version=v1'
    );
  });

  test('builds azure model with defaults when secretValue and resourceName are not provided', () => {
    const model = asConfigured(
      buildModel({
        provider: 'azure',
        secretValue: null,
        model: 'gpt-4o',
      })
    );
    expect(model.modelId).toBe('gpt-4o');
    expect(model.config.url({ path: '/responses', modelId: 'gpt-4o' })).toBe(
      'https://.openai.azure.com/openai/v1/responses?api-version=v1'
    );
  });

  test('builds ollama model wired to the default local base URL', () => {
    const model = asConfigured(
      buildModel({
        provider: 'ollama',
        secretValue: null,
        model: 'qwen2.5:0.5b',
      })
    );
    expect(model.modelId).toBe('qwen2.5:0.5b');
    expect(
      model.config.url({ path: '/chat/completions', modelId: 'qwen2.5:0.5b' })
    ).toBe('http://localhost:11434/v1/chat/completions');
  });

  test('builds gateway model wired to the configured base URL', () => {
    const model = asConfigured(
      buildModel({
        provider: 'gateway',
        secretValue: 'test-key',
        model: 'gpt-4o',
        baseUrl: 'https://my-gateway.example.com',
      })
    );
    expect(model.modelId).toBe('gpt-4o');
    expect(
      model.config.url({ path: '/chat/completions', modelId: 'gpt-4o' })
    ).toBe('https://my-gateway.example.com/chat/completions');
  });

  test('builds custom model wired to the configured base URL', () => {
    const model = asConfigured(
      buildModel({
        provider: 'custom',
        secretValue: 'test-key',
        model: 'my-custom-model',
        baseUrl: 'https://my-custom.example.com',
      })
    );
    expect(model.modelId).toBe('my-custom-model');
    expect(
      model.config.url({
        path: '/chat/completions',
        modelId: 'my-custom-model',
      })
    ).toBe('https://my-custom.example.com/chat/completions');
  });

  test('builds bedrock model with the requested model id and region', () => {
    const model = asConfigured(
      buildModel({
        provider: 'bedrock',
        secretValue: null,
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        config: { region: 'us-west-2' },
      })
    );
    expect(model.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(model.config.baseUrl()).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com'
    );
  });

  test('builds vertex model wired to the configured project and location', () => {
    const model = asConfigured(
      buildModel({
        provider: 'vertex',
        secretValue: SERVICE_ACCOUNT_SECRET,
        model: 'gemini-2.0-flash',
        config: { project: 'my-gcp-project', location: 'europe-west4' },
      })
    );
    expect(model.modelId).toBe('gemini-2.0-flash');
    expect(model.config.provider).toBe('google.vertex.chat');
    expect(model.config.baseURL).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1beta1/projects/my-gcp-project/locations/europe-west4/publishers/google'
    );
  });

  test('builds vertex model taking the project from the service-account secret', () => {
    const model = asConfigured(
      buildModel({
        provider: 'vertex',
        secretValue: SERVICE_ACCOUNT_SECRET,
        model: 'gemini-2.0-flash',
      })
    );
    // project_id comes from the key file, location falls back to the default
    expect(model.config.baseURL).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/sa-project/locations/us-central1/publishers/google'
    );
  });

  test('builds vertex model in express mode from a plain API-key secret', () => {
    const model = asConfigured(
      buildModel({
        provider: 'vertex',
        secretValue: 'AIzaSyExpressModeKey',
        model: 'gemini-2.0-flash',
      })
    );
    // Express mode is project-less: it targets the global aiplatform endpoint
    expect(model.config.baseURL).toBe(
      'https://aiplatform.googleapis.com/v1/publishers/google'
    );
  });

  test('throws a DomainError when a vertex project cannot be resolved', () => {
    expect(() => {
      buildModel({
        provider: 'vertex',
        secretValue: null,
        model: 'gemini-2.0-flash',
      });
    }).toThrow(DomainError);
    expect(() => {
      buildModel({
        provider: 'vertex',
        secretValue: null,
        model: 'gemini-2.0-flash',
      });
    }).toThrow(/config\.project/);
  });
});

// Mirrors the `resolveBedrockCredentials` rationale: the model object the AI
// SDK returns does not expose which credential branch was taken (auth happens
// at request time), so the precedence rules are asserted on the resolver.
describe('resolveVertexSettings', () => {
  test('treats a plain non-JSON secret as an express-mode API key', () => {
    expect(
      resolveVertexSettings({ secretValue: 'AIzaSyExpressModeKey' })
    ).toEqual({ apiKey: 'AIzaSyExpressModeKey' });
  });

  test('uses apiKey from a JSON secret', () => {
    expect(
      resolveVertexSettings({
        secretValue: JSON.stringify({ apiKey: 'AIzaFromJson' }),
      })
    ).toEqual({ apiKey: 'AIzaFromJson' });
  });

  test('falls back to config.apiKey when no secret is provided', () => {
    expect(
      resolveVertexSettings({
        secretValue: null,
        config: { apiKey: 'AIzaFromConfig' },
      })
    ).toEqual({ apiKey: 'AIzaFromConfig' });
  });

  test('a secret apiKey takes precedence over config.apiKey', () => {
    expect(
      resolveVertexSettings({
        secretValue: JSON.stringify({ apiKey: 'AIzaFromSecret' }),
        config: { apiKey: 'AIzaFromConfig' },
      })
    ).toEqual({ apiKey: 'AIzaFromSecret' });
  });

  test('uses service-account credentials from a JSON key file secret', () => {
    expect(
      resolveVertexSettings({
        secretValue: SERVICE_ACCOUNT_SECRET,
        config: { location: 'europe-west4' },
      })
    ).toEqual({
      project: 'sa-project',
      location: 'europe-west4',
      googleAuthOptions: {
        credentials: {
          client_email: 'vertex@sa-project.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END',
        },
      },
    });
  });

  test('config.project takes precedence over the key file project_id', () => {
    const settings = resolveVertexSettings({
      secretValue: SERVICE_ACCOUNT_SECRET,
      config: { project: 'override-project' },
    });
    expect(settings).toMatchObject({
      project: 'override-project',
      location: 'us-central1',
    });
  });

  test('falls back to Application Default Credentials when no secret is linked', () => {
    expect(
      resolveVertexSettings({
        secretValue: null,
        config: { project: 'adc-project', location: 'global' },
      })
    ).toEqual({ project: 'adc-project', location: 'global' });
  });

  test('ignores an incomplete service-account key file and falls back to ADC', () => {
    expect(
      resolveVertexSettings({
        secretValue: JSON.stringify({
          project_id: 'sa-project',
          client_email: 'vertex@sa-project.iam.gserviceaccount.com',
        }),
      })
    ).toEqual({ project: 'sa-project', location: 'us-central1' });
  });

  test('throws when no project can be resolved for a non-express provider', () => {
    expect(() => {
      return resolveVertexSettings({ secretValue: null });
    }).toThrow(DomainError);
  });
});

// `resolveBedrockCredentials` is tested directly because the returned model does
// not expose which credential branch it took — signing happens at request time.
describe('resolveBedrockCredentials', () => {
  test('falls back to the AWS default credential chain when nothing is provided', () => {
    const result = resolveBedrockCredentials({ secretValue: null });
    expect(result.region).toBe('us-east-1');
    expect('credentialProvider' in result).toBe(true);
    if ('credentialProvider' in result) {
      expect(typeof result.credentialProvider).toBe('function');
    }
  });

  test('falls back to the AWS default credential chain when the key pair is incomplete', () => {
    const result = resolveBedrockCredentials({
      secretValue: JSON.stringify({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }),
    });
    expect(result.region).toBe('us-east-1');
    expect('credentialProvider' in result).toBe(true);
    if ('credentialProvider' in result) {
      expect(typeof result.credentialProvider).toBe('function');
    }
  });

  test('uses accessKeyId/secretAccessKey from a JSON credentials secret', () => {
    const credentials = JSON.stringify({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(
      resolveBedrockCredentials({
        secretValue: credentials,
        config: { region: 'us-west-2' },
      })
    ).toEqual({
      region: 'us-west-2',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: undefined,
    });
  });

  test('falls back to the AWS default credential chain when the secret is invalid JSON and not an ABSK token', () => {
    const result = resolveBedrockCredentials({ secretValue: 'not-valid-json' });
    expect(result.region).toBe('us-east-1');
    expect('credentialProvider' in result).toBe(true);
    if ('credentialProvider' in result) {
      expect(typeof result.credentialProvider).toBe('function');
    }
  });

  test('uses apiKey from a JSON secret', () => {
    expect(
      resolveBedrockCredentials({
        secretValue: JSON.stringify({ apiKey: 'ABSK-test-key' }),
      })
    ).toEqual({ region: 'us-east-1', apiKey: 'ABSK-test-key' });
  });

  test('treats a plain ABSK-prefixed secret as a bearer apiKey', () => {
    expect(
      resolveBedrockCredentials({ secretValue: 'ABSKsomeplainkey' })
    ).toEqual({ region: 'us-east-1', apiKey: 'ABSKsomeplainkey' });
  });

  test('falls back to config.apiKey when no secret is provided', () => {
    expect(
      resolveBedrockCredentials({
        secretValue: null,
        config: { apiKey: 'ABSKfromconfig' },
      })
    ).toEqual({ region: 'us-east-1', apiKey: 'ABSKfromconfig' });
  });

  test('a secret apiKey takes precedence over config.apiKey', () => {
    expect(
      resolveBedrockCredentials({
        secretValue: JSON.stringify({ apiKey: 'ABSKfromsecret' }),
        config: { apiKey: 'ABSKfromconfig' },
      })
    ).toEqual({ region: 'us-east-1', apiKey: 'ABSKfromsecret' });
  });
});
