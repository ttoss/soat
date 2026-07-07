import type { ToolDefinition } from 'src/lib/soatToolsHelpers';

// `soatTools` loads OpenAPI specs from disk at import time. Only the external
// I/O it depends on — `node:fs` and `js-yaml` — is mocked here; the real
// `processPath`/`processOperation` pipeline runs against the fake specs, so the
// assertions exercise genuine tool derivation (no internal-module mock).

describe('soatTools', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.unmock('node:fs');
    jest.unmock('js-yaml');
  });

  const loadSoatTools = (): ToolDefinition[] => {
    const { soatTools } = jest.requireActual('src/lib/soatTools') as {
      soatTools: ToolDefinition[];
    };
    return soatTools;
  };

  test('returns empty list when OpenAPI spec directory does not exist', async () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return false;
        }),
        readdirSync: jest.fn(),
        readFileSync: jest.fn(),
      };
    });

    expect(loadSoatTools()).toEqual([]);
  });

  test('loads only yaml files, sorts filenames, and flattens path tools', async () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['b.yaml', 'ignore.json', 'a.yaml'];
        }),
        readFileSync: jest.fn((filePath: string) => {
          return filePath;
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        __esModule: true,
        default: {
          load: jest.fn((content: string) => {
            if (content.includes('a.yaml')) {
              return { paths: { '/a': { get: { operationId: 'getAThing' } } } };
            }
            return {
              paths: { '/b': { post: { operationId: 'createBThing' } } },
            };
          }),
        },
      };
    });

    // The real processPath/processOperation pipeline turns each operation into
    // a tool named after its operationId (camelCase → kebab-case). `ignore.json`
    // is not a `.yaml` file, so it is never read; `a.yaml` sorts before `b.yaml`.
    const names = loadSoatTools().map((tool) => {
      return tool.name;
    });
    expect(names).toEqual(['get-a-thing', 'create-b-thing']);
  });

  test('ignores a malformed yaml file and continues with other files', async () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['broken.yaml', 'good.yaml'];
        }),
        readFileSync: jest.fn((filePath: string) => {
          return filePath;
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        __esModule: true,
        default: {
          load: jest.fn((content: string) => {
            if (content.includes('broken.yaml')) {
              throw new Error('bad yaml');
            }
            return { paths: { '/ok': { get: { operationId: 'getOk' } } } };
          }),
        },
      };
    });

    const names = loadSoatTools().map((tool) => {
      return tool.name;
    });
    expect(names).toEqual(['get-ok']);
  });
});
