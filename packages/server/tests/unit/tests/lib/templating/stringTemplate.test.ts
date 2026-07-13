import {
  collectTokens,
  renderRecord,
  renderTemplate,
} from 'src/lib/templating/stringTemplate';

describe('templating/stringTemplate', () => {
  describe('renderTemplate', () => {
    test('substitutes a single token via its namespace resolver', () => {
      const result = renderTemplate('/cities/${arg.city}', {
        resolvers: {
          arg: (p) => {
            return p === 'city' ? 'Berlin' : undefined;
          },
        },
      });
      expect(result.output).toBe('/cities/Berlin');
      expect(result.consumed).toEqual(['arg.city']);
    });

    test('substitutes multiple tokens', () => {
      const result = renderTemplate('${arg.a}-${arg.b}', {
        resolvers: {
          arg: (p) => {
            return p === 'a' ? 'x' : 'y';
          },
        },
      });
      expect(result.output).toBe('x-y');
    });

    test('resolves a dotted path through the resolver', () => {
      const ctx: Record<string, unknown> = { user: { id: 'u9' } };
      const result = renderTemplate('${arg.user.id}', {
        resolvers: {
          arg: (p) => {
            // resolver receives the path after the namespace
            return p === 'user.id' ? String(ctx.user && 'u9') : undefined;
          },
        },
      });
      expect(result.output).toBe('u9');
      expect(result.consumed).toEqual(['arg.user.id']);
    });

    test('leaves a token verbatim and records it as deferred when its namespace has no resolver', () => {
      const result = renderTemplate('${arg.city}/${secret.sec_1}', {
        resolvers: {
          arg: () => {
            return 'Berlin';
          },
        },
      });
      expect(result.output).toBe('Berlin/${secret.sec_1}');
      expect(result.deferred).toEqual(['secret.sec_1']);
      expect(result.consumed).toEqual(['arg.city']);
    });

    test('leaves a token verbatim (missing) when the resolver returns undefined, but records it as referenced not deferred', () => {
      const result = renderTemplate('${arg.missing}', {
        resolvers: {
          arg: () => {
            return undefined;
          },
        },
      });
      expect(result.output).toBe('${arg.missing}');
      expect(result.consumed).toEqual([]);
      expect(result.deferred).toEqual([]);
      expect(result.referenced).toEqual([
        { namespace: 'arg', path: 'missing', raw: 'arg.missing' },
      ]);
    });

    test('URL-encodes substituted values when encode is true', () => {
      const result = renderTemplate('/q/${arg.q}', {
        resolvers: {
          arg: () => {
            return 'hello world';
          },
        },
        encode: true,
      });
      expect(result.output).toBe('/q/hello%20world');
    });

    test('does not encode when encode is false', () => {
      const result = renderTemplate('${arg.q}', {
        resolvers: {
          arg: () => {
            return 'hello world';
          },
        },
      });
      expect(result.output).toBe('hello world');
    });

    test('resolves a namespace-only token (empty path)', () => {
      const result = renderTemplate('${topic}', {
        resolvers: {
          topic: (p) => {
            return p === '' ? 'AI' : undefined;
          },
        },
      });
      expect(result.output).toBe('AI');
      expect(result.consumed).toEqual(['topic']);
    });

    test('records every token in referenced, including deferred ones', () => {
      const result = renderTemplate('${arg.a}${secret.sec_1}', {
        resolvers: {
          arg: () => {
            return 'x';
          },
        },
      });
      expect(result.referenced).toEqual([
        { namespace: 'arg', path: 'a', raw: 'arg.a' },
        { namespace: 'secret', path: 'sec_1', raw: 'secret.sec_1' },
      ]);
    });

    test('treats $${...} as an escaped literal, not a token', () => {
      const result = renderTemplate('$${arg.city}', {
        resolvers: {
          arg: () => {
            return 'SHOULD_NOT_APPEAR';
          },
        },
      });
      expect(result.output).toBe('${arg.city}');
      expect(result.referenced).toEqual([]);
      expect(result.consumed).toEqual([]);
    });

    test('leaves non-token braces untouched', () => {
      const result = renderTemplate('a {plain} b', { resolvers: {} });
      expect(result.output).toBe('a {plain} b');
      expect(result.referenced).toEqual([]);
    });
  });

  describe('collectTokens', () => {
    test('collects tokens from a plain string', () => {
      expect(collectTokens('${arg.a}/${secret.sec_1}')).toEqual([
        { namespace: 'arg', path: 'a', raw: 'arg.a' },
        { namespace: 'secret', path: 'sec_1', raw: 'secret.sec_1' },
      ]);
    });

    test('deep-walks nested objects and arrays', () => {
      const refs = collectTokens({
        url: '${arg.id}',
        headers: { Authorization: 'Bearer ${secret.sec_1}' },
        list: ['${param.Env}'],
      });
      expect(
        refs
          .map((r) => {
            return r.raw;
          })
          .sort()
      ).toEqual(['arg.id', 'param.Env', 'secret.sec_1']);
    });

    test('ignores escaped literals', () => {
      expect(collectTokens('$${arg.a}')).toEqual([]);
    });

    test('returns empty for non-string primitives', () => {
      expect(collectTokens(42)).toEqual([]);
      expect(collectTokens(null)).toEqual([]);
    });
  });

  describe('renderRecord', () => {
    test('renders every string value of a record', () => {
      const { output } = renderRecord(
        { Authorization: 'Bearer ${secret.sec_1}', 'X-Plain': 'static' },
        {
          resolvers: {
            secret: () => {
              return 'shhh';
            },
          },
        }
      );
      expect(output).toEqual({
        Authorization: 'Bearer shhh',
        'X-Plain': 'static',
      });
    });

    test('aggregates deferred tokens across values', () => {
      const { deferred } = renderRecord(
        { a: '${secret.sec_1}', b: '${secret.sec_2}' },
        { resolvers: {} }
      );
      expect(deferred.sort()).toEqual(['secret.sec_1', 'secret.sec_2']);
    });
  });
});
