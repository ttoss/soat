import {
  assertAiProviderConfig,
  readUrlConfigValue,
} from 'src/lib/aiProviderConfigValidation';

describe('readUrlConfigValue', () => {
  test.each([
    ['us-central1'],
    ['global'],
    ['eu'],
    ['us-gov-west-1'],
    ['my-azure-resource'],
  ])('accepts %s', (value) => {
    expect(
      readUrlConfigValue({ provider: 'vertex', key: 'location', value })
    ).toBe(value);
  });

  test('returns undefined when the value is absent', () => {
    expect(
      readUrlConfigValue({
        provider: 'vertex',
        key: 'location',
        value: undefined,
      })
    ).toBeUndefined();
    expect(
      readUrlConfigValue({ provider: 'vertex', key: 'location', value: null })
    ).toBeUndefined();
  });

  // Each of these escapes the host template the provider SDK builds — a
  // trailing slash, a dot or an `@` is enough to name a different server.
  test.each([
    ['evil.example.com/'],
    ['evil.example.com'],
    ['x@evil.example.com'],
    ['us-central1.evil.example.com'],
    ['us-central1:8080'],
    ['../../etc'],
    ['us central1'],
    ['-us-central1'],
    ['us-central1-'],
    [''],
    ['a'.repeat(64)],
  ])('refuses %s', (value) => {
    expect(() => {
      return readUrlConfigValue({ provider: 'vertex', key: 'location', value });
    }).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_MISCONFIGURED' }));
  });

  test('refuses a value that is not a string', () => {
    expect(() => {
      return readUrlConfigValue({
        provider: 'bedrock',
        key: 'region',
        value: {
          toString: () => {
            return 'us-east-1';
          },
        },
      });
    }).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_MISCONFIGURED' }));
  });

  test('names the provider and the field it refused', () => {
    expect(() => {
      return readUrlConfigValue({
        provider: 'bedrock',
        key: 'region',
        value: 'evil.example.com/',
      });
    }).toThrow(/bedrock.*config\.region/);
  });
});

describe('assertAiProviderConfig', () => {
  test('accepts a vertex record with a real location', () => {
    expect(() => {
      return assertAiProviderConfig({
        provider: 'vertex',
        config: { project: 'my-project', location: 'us-central1' },
      });
    }).not.toThrow();
  });

  test('refuses a vertex location that would move the host', () => {
    expect(() => {
      return assertAiProviderConfig({
        provider: 'vertex',
        config: { project: 'p', location: 'evil.example.com/' },
      });
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  test('refuses a vertex project that would move the path', () => {
    expect(() => {
      return assertAiProviderConfig({
        provider: 'vertex',
        config: { project: '../../v1/projects/victim' },
      });
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  test('refuses a bedrock region that would move the host', () => {
    expect(() => {
      return assertAiProviderConfig({
        provider: 'bedrock',
        config: { region: 'evil.example.com/' },
      });
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  test('refuses an azure resource name that would move the host', () => {
    expect(() => {
      return assertAiProviderConfig({
        provider: 'azure',
        config: { resourceName: 'evil.example.com/x' },
      });
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  test('ignores a config key the provider does not splice into a URL', () => {
    expect(() => {
      return assertAiProviderConfig({
        provider: 'bedrock',
        config: { apiKey: 'ABSK-not/a/label', region: 'us-east-1' },
      });
    }).not.toThrow();
  });

  test('accepts an absent config and an absent base_url', () => {
    expect(() => {
      return assertAiProviderConfig({ provider: 'openai' });
    }).not.toThrow();
    expect(() => {
      return assertAiProviderConfig({
        provider: 'openai',
        baseUrl: null,
        config: null,
      });
    }).not.toThrow();
  });

  test.each([
    ['https://gateway.example.com/v1'],
    ['http://gateway.example.com:8080/v1'],
  ])('accepts base_url %s', (baseUrl) => {
    expect(() => {
      return assertAiProviderConfig({ provider: 'openai', baseUrl });
    }).not.toThrow();
  });

  test.each([
    ['not-a-url'],
    ['file:///etc/passwd'],
    ['ftp://gateway.example.com'],
    ['https://user:pass@gateway.example.com/v1'],
  ])('refuses base_url %s', (baseUrl) => {
    expect(() => {
      return assertAiProviderConfig({ provider: 'openai', baseUrl });
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
