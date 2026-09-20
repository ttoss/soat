import {
  assertCallerPath,
  buildPath,
  filenameFromPath,
  isSystemPath,
  normalizePath,
  prefixFromPath,
  rebuildKey,
  systemPath,
} from 'src/lib/filePaths';

describe('filePaths', () => {
  describe('normalizePath', () => {
    test('prepends a leading slash when missing', () => {
      expect(normalizePath('report.txt')).toBe('/report.txt');
    });

    test('keeps an existing leading slash and collapses repeats', () => {
      expect(normalizePath('//a///b.txt')).toBe('/a/b.txt');
    });

    test('resolves . and .. segments', () => {
      expect(normalizePath('/a/b/../c/./d.txt')).toBe('/a/c/d.txt');
    });

    test('throws when .. escapes above the root', () => {
      expect(() => {
        return normalizePath('/../etc/passwd');
      }).toThrow(/above root is not allowed/);
    });

    test('normalizes the bare root to /', () => {
      expect(normalizePath('/')).toBe('/');
    });
  });

  describe('filenameFromPath', () => {
    test('returns the last segment', () => {
      expect(filenameFromPath('/temas/report.txt')).toBe('report.txt');
    });

    test('returns undefined for null', () => {
      expect(filenameFromPath(null)).toBeUndefined();
    });

    test('returns undefined for the bare root', () => {
      expect(filenameFromPath('/')).toBeUndefined();
    });
  });

  describe('prefixFromPath', () => {
    test('returns the directory part for a nested path', () => {
      expect(prefixFromPath('/a/b/c.txt')).toBe('/a/b');
    });

    test('returns / for a root-level file', () => {
      expect(prefixFromPath('/report.txt')).toBe('/');
    });

    test('returns undefined for null', () => {
      expect(prefixFromPath(null)).toBeUndefined();
    });
  });

  describe('buildPath', () => {
    test('joins prefix and filename', () => {
      expect(buildPath({ prefix: '/reports', filename: 'q1.pdf' })).toBe(
        '/reports/q1.pdf'
      );
    });

    test('defaults the prefix to root when omitted', () => {
      expect(buildPath({ filename: 'q1.pdf' })).toBe('/q1.pdf');
    });

    test('treats a blank prefix as root', () => {
      expect(buildPath({ prefix: '   ', filename: 'q1.pdf' })).toBe('/q1.pdf');
    });

    test('returns null when there is no filename and root prefix', () => {
      expect(buildPath({})).toBeNull();
      expect(buildPath({ prefix: '/' })).toBeNull();
    });

    test('returns the prefix alone when no filename but a real prefix', () => {
      expect(buildPath({ prefix: '/reports' })).toBe('/reports');
    });
  });

  describe('rebuildKey', () => {
    test('uses provided prefix and filename', () => {
      expect(
        rebuildKey({
          currentPath: '/old/name.txt',
          currentFilename: 'name.txt',
          prefix: '/new',
          filename: 'renamed.txt',
        })
      ).toEqual({ path: '/new/renamed.txt', filename: 'renamed.txt' });
    });

    test('falls back to the current prefix when only filename changes', () => {
      expect(
        rebuildKey({
          currentPath: '/dir/old.txt',
          currentFilename: 'old.txt',
          filename: 'new.txt',
        })
      ).toEqual({ path: '/dir/new.txt', filename: 'new.txt' });
    });

    test('falls back to the current filename when only prefix changes', () => {
      expect(
        rebuildKey({
          currentPath: '/dir/keep.txt',
          currentFilename: 'keep.txt',
          prefix: '/moved',
        })
      ).toEqual({ path: '/moved/keep.txt', filename: 'keep.txt' });
    });

    test('derives the filename from the current path when none is stored', () => {
      expect(
        rebuildKey({
          currentPath: '/dir/derived.txt',
          prefix: '/moved',
        })
      ).toEqual({ path: '/moved/derived.txt', filename: 'derived.txt' });
    });

    test('defaults the prefix to root when the current path has none', () => {
      expect(
        rebuildKey({
          currentPath: null,
          filename: 'fresh.txt',
        })
      ).toEqual({ path: '/fresh.txt', filename: 'fresh.txt' });
    });
  });
});

describe('the reserved system root', () => {
  describe('systemPath', () => {
    test('files a module write under /.system/<module>/', () => {
      expect(systemPath({ module: 'traces', leaf: 'trace_abc.json' })).toBe(
        '/.system/traces/trace_abc.json'
      );
    });

    test('keeps a nested leaf, so a module may group by owner', () => {
      expect(
        systemPath({ module: 'conversations', leaf: 'conv_1/doc_2.txt' })
      ).toBe('/.system/conversations/conv_1/doc_2.txt');
    });

    test('refuses a leaf that climbs out of its module directory', () => {
      expect(() => {
        return systemPath({ module: 'traces', leaf: '../../etc/passwd' });
      }).toThrow(/escapes/i);
    });

    test('refuses a module that is not a single plain segment', () => {
      expect(() => {
        return systemPath({ module: 'a/b', leaf: 'x.txt' });
      }).toThrow(/single path segment/);
    });
  });

  describe('isSystemPath', () => {
    test.each([
      ['/.system/traces/t.json', true],
      ['/.system', true],
      ['/traces/t.json', false],
      ['/.systemic/t.json', false],
      [null, false],
    ])('%s → %s', (path, expected) => {
      expect(isSystemPath(path)).toBe(expected);
    });
  });

  describe('assertCallerPath', () => {
    test('returns a caller path unchanged', () => {
      expect(assertCallerPath('/reports/q1.txt')).toBe('/reports/q1.txt');
      expect(assertCallerPath(null)).toBeNull();
    });

    test('refuses a write into the reserved root', () => {
      expect(() => {
        return assertCallerPath('/.system/traces/t.json');
      }).toThrow(/reserved/i);
    });

    test('refuses the un-normalized spellings of it too', () => {
      for (const path of ['.system/x', '/a/../.system/x', '//.system//x']) {
        expect(() => {
          return assertCallerPath(path);
        }).toThrow(/reserved/i);
      }
    });
  });
});
