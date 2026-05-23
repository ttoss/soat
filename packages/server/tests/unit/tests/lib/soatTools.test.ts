describe('soatTools', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.unmock('node:fs');
    jest.unmock('js-yaml');
    jest.unmock('src/lib/soatToolsHelpers');
  });

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

    const { soatTools } = await import('src/lib/soatTools');

    expect(soatTools).toEqual([]);
  });

  test('loads only yaml files, sorts filenames, and flattens path tools', async () => {
    const processPath = jest.fn(
      ({ pathTemplate }: { pathTemplate: string }): Array<{ id: string }> => {
        return [{ id: `tool:${pathTemplate}` }];
      }
    );

    jest.doMock('src/lib/soatToolsHelpers', () => {
      return { processPath };
    });

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
              return { paths: { '/a': { get: {} } } };
            }
            return { paths: { '/b': { post: {} } } };
          }),
        },
      };
    });

    const { soatTools } = await import('src/lib/soatTools');

    expect(soatTools).toEqual([{ id: 'tool:/a' }, { id: 'tool:/b' }]);
    expect(processPath).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pathTemplate: '/a' })
    );
    expect(processPath).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pathTemplate: '/b' })
    );
  });

  test('ignores a malformed yaml file and continues with other files', async () => {
    const processPath = jest.fn(
      ({ pathTemplate }: { pathTemplate: string }): Array<{ id: string }> => {
        return [{ id: `tool:${pathTemplate}` }];
      }
    );

    jest.doMock('src/lib/soatToolsHelpers', () => {
      return { processPath };
    });

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
            return { paths: { '/ok': { get: {} } } };
          }),
        },
      };
    });

    const { soatTools } = await import('src/lib/soatTools');

    expect(soatTools).toEqual([{ id: 'tool:/ok' }]);
    expect(processPath).toHaveBeenCalledTimes(1);
    expect(processPath).toHaveBeenCalledWith(
      expect.objectContaining({ pathTemplate: '/ok' })
    );
  });
});
