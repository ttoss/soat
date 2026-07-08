import { buildModel, resolveBedrockCredentials } from 'src/lib/agentModel';

// The AI SDK's returned LanguageModel exposes `modelId` and `config.provider`
// regardless of provider, plus (for OpenAI-compatible builders) a
// `config.url` function that resolves the actual request endpoint — enough
// to assert the model string and base URL/resource wiring landed correctly,
// instead of only checking that `buildModel` didn't throw.

const asConfigured = (model: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return model as any;
};

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
});

// `buildBedrockModel` delegates credential precedence to
// `resolveBedrockCredentials`, which is now tested directly: the AI SDK's
// returned model object doesn't expose which credential branch it took
// (headers/signing happen at request time), so asserting on the model
// itself couldn't distinguish correct from incorrect wiring.
describe('resolveBedrockCredentials', () => {
  test('defaults to us-east-1 and no credentials when nothing is provided', () => {
    expect(resolveBedrockCredentials({ secretValue: null })).toEqual({
      region: 'us-east-1',
      accessKeyId: undefined,
      secretAccessKey: undefined,
      sessionToken: undefined,
    });
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

  test('falls back to no credentials when the secret is invalid JSON and not an ABSK token', () => {
    expect(
      resolveBedrockCredentials({ secretValue: 'not-valid-json' })
    ).toEqual({
      region: 'us-east-1',
      accessKeyId: undefined,
      secretAccessKey: undefined,
      sessionToken: undefined,
    });
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
