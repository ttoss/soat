import { getPath } from 'src/lib/templating/path';

describe('templating/path', () => {
  describe('getPath', () => {
    test('reads a top-level key', () => {
      expect(getPath({ city: 'Berlin' }, 'city')).toBe('Berlin');
    });

    test('reads a nested dotted path', () => {
      expect(getPath({ user: { id: 'u1' } }, 'user.id')).toBe('u1');
    });

    test('reads an array index', () => {
      expect(getPath({ items: ['a', 'b'] }, 'items.1')).toBe('b');
    });

    test('returns undefined for a missing key', () => {
      expect(getPath({ a: 1 }, 'b')).toBeUndefined();
    });

    test('returns undefined when descending through a non-object', () => {
      expect(getPath({ a: 5 }, 'a.b')).toBeUndefined();
    });

    test('returns undefined when descending through null', () => {
      expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    });

    test('returns the root context for an empty path', () => {
      const ctx = { a: 1 };
      expect(getPath(ctx, '')).toBe(ctx);
    });

    test('returns undefined for a path on a non-object root', () => {
      expect(getPath('scalar', 'a')).toBeUndefined();
    });
  });
});
