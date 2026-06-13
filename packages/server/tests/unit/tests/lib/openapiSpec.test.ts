type MergedSpec = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
};

type OpenapiSpecModule = {
  loadMergedOpenApiSpec: () => MergedSpec;
  getMergedOpenApiSpec: () => MergedSpec;
};

describe('openapiSpec', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.unmock('node:fs');
    jest.unmock('js-yaml');
  });

  test('returns empty spec when specDir does not exist', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return false;
        }),
        readdirSync: jest.fn(),
        readFileSync: jest.fn(),
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.paths).toEqual({});
    expect(spec.components.schemas).toEqual({});
    expect(spec.components.securitySchemes).toEqual({});
  });

  test('skips files that fail to parse and returns empty spec', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['broken.yaml'];
        }),
        readFileSync: jest.fn(() => {
          throw new Error('read error');
        }),
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.paths).toEqual({});
  });

  test('merges spec with no paths or components gracefully', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['minimal.yaml'];
        }),
        readFileSync: jest.fn(() => {
          return 'openapi: 3.0.0';
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        __esModule: true,
        default: {
          load: jest.fn(() => {
            return { openapi: '3.0.0' };
          }),
        },
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.paths).toEqual({});
    expect(spec.components.schemas).toEqual({});
    expect(spec.components.securitySchemes).toEqual({});
  });

  test('merges spec with components but no securitySchemes', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['partial.yaml'];
        }),
        readFileSync: jest.fn(() => {
          return '';
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        __esModule: true,
        default: {
          load: jest.fn(() => {
            return {
              paths: { '/test': { get: {} } },
              components: { schemas: { Foo: { type: 'object' } } },
            };
          }),
        },
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.paths['/test']).toBeDefined();
    expect(spec.components.schemas['Foo']).toBeDefined();
    expect(spec.components.securitySchemes).toEqual({});
  });

  test('getMergedOpenApiSpec caches the result on second call', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['spec.yaml'];
        }),
        readFileSync: jest.fn(() => {
          return '';
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        __esModule: true,
        default: {
          load: jest.fn(() => {
            return { paths: { '/cached': {} } };
          }),
        },
      };
    });

    const { getMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const first = getMergedOpenApiSpec();
    const second = getMergedOpenApiSpec();
    expect(first).toBe(second);
  });
});
