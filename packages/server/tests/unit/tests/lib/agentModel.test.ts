import { buildModel } from 'src/lib/agentModel';

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

  test('builds openai model without throwing', () => {
    const model = buildModel({
      provider: 'openai',
      secretValue: 'test-key',
      model: 'gpt-4o',
    });
    expect(model).toBeDefined();
  });

  test('builds anthropic model without throwing', () => {
    const model = buildModel({
      provider: 'anthropic',
      secretValue: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
    });
    expect(model).toBeDefined();
  });

  test('builds google model without throwing', () => {
    const model = buildModel({
      provider: 'google',
      secretValue: 'test-key',
      model: 'gemini-2.0-flash',
    });
    expect(model).toBeDefined();
  });

  test('builds xai model without throwing', () => {
    const model = buildModel({
      provider: 'xai',
      secretValue: 'test-key',
      model: 'grok-2-latest',
    });
    expect(model).toBeDefined();
  });

  test('builds groq model without throwing', () => {
    const model = buildModel({
      provider: 'groq',
      secretValue: 'test-key',
      model: 'llama-3.3-70b-versatile',
    });
    expect(model).toBeDefined();
  });

  test('builds azure model without throwing', () => {
    const model = buildModel({
      provider: 'azure',
      secretValue: 'test-key',
      model: 'gpt-4o',
      config: { resourceName: 'my-resource' },
    });
    expect(model).toBeDefined();
  });

  test('builds bedrock model without throwing', () => {
    const model = buildModel({
      provider: 'bedrock',
      secretValue: null,
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    });
    expect(model).toBeDefined();
  });

  test('builds bedrock model with credentials JSON without throwing', () => {
    const credentials = JSON.stringify({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const model = buildModel({
      provider: 'bedrock',
      secretValue: credentials,
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      config: { region: 'us-west-2' },
    });
    expect(model).toBeDefined();
  });

  test('builds bedrock model with invalid credentials JSON falls back gracefully', () => {
    const model = buildModel({
      provider: 'bedrock',
      secretValue: 'not-valid-json',
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    });
    expect(model).toBeDefined();
  });

  test('builds ollama model without throwing', () => {
    const model = buildModel({
      provider: 'ollama',
      secretValue: null,
      model: 'qwen2.5:0.5b',
    });
    expect(model).toBeDefined();
  });

  test('builds gateway model without throwing', () => {
    const model = buildModel({
      provider: 'gateway',
      secretValue: 'test-key',
      model: 'gpt-4o',
      baseUrl: 'https://my-gateway.example.com',
    });
    expect(model).toBeDefined();
  });

  test('builds custom model without throwing', () => {
    const model = buildModel({
      provider: 'custom',
      secretValue: 'test-key',
      model: 'my-custom-model',
      baseUrl: 'https://my-custom.example.com',
    });
    expect(model).toBeDefined();
  });
});
