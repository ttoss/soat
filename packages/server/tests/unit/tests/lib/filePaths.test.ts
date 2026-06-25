import {
  buildPath,
  filenameFromPath,
  normalizePath,
  prefixFromPath,
  rebuildKey,
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
