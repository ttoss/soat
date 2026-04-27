import { resolveUrlPathParams } from 'src/lib/agents';

describe('resolveUrlPathParams', () => {
  test('substitutes path params and excludes them from remaining args', () => {
    const { resolvedUrl, remainingArgs } = resolveUrlPathParams({
      url: 'https://api.example.com/users/{userId}/posts/{postId}',
      toolArgs: { userId: '123', postId: '456', extra: 'value' },
    });

    expect(resolvedUrl).toBe('https://api.example.com/users/123/posts/456');
    expect(remainingArgs).toEqual({ extra: 'value' });
    expect(remainingArgs).not.toHaveProperty('userId');
    expect(remainingArgs).not.toHaveProperty('postId');
  });

  test('URL-encodes path param values', () => {
    const { resolvedUrl } = resolveUrlPathParams({
      url: 'https://api.example.com/items/{id}',
      toolArgs: { id: 'hello world/test' },
    });

    expect(resolvedUrl).toBe(
      'https://api.example.com/items/hello%20world%2Ftest'
    );
  });

  test('leaves placeholder as-is when no matching arg is present', () => {
    const { resolvedUrl, remainingArgs } = resolveUrlPathParams({
      url: 'https://api.example.com/users/{userId}',
      toolArgs: { extra: 'value' },
    });

    expect(resolvedUrl).toBe('https://api.example.com/users/{userId}');
    expect(remainingArgs).toEqual({ extra: 'value' });
  });

  test('URL with no placeholders returns all args as remainingArgs', () => {
    const { resolvedUrl, remainingArgs } = resolveUrlPathParams({
      url: 'https://api.example.com/items',
      toolArgs: { q: 'search', limit: 10 },
    });

    expect(resolvedUrl).toBe('https://api.example.com/items');
    expect(remainingArgs).toEqual({ q: 'search', limit: 10 });
  });

  test('empty toolArgs leaves placeholders as-is', () => {
    const { resolvedUrl, remainingArgs } = resolveUrlPathParams({
      url: 'https://api.example.com/users/{userId}',
      toolArgs: {},
    });

    expect(resolvedUrl).toBe('https://api.example.com/users/{userId}');
    expect(remainingArgs).toEqual({});
  });

  test('path params are excluded from remaining args (GET query string scenario)', () => {
    const { resolvedUrl, remainingArgs } = resolveUrlPathParams({
      url: 'https://api.example.com/projects/{projectId}/files',
      toolArgs: { projectId: 'proj_abc', filter: 'active', limit: '20' },
    });

    expect(resolvedUrl).toBe('https://api.example.com/projects/proj_abc/files');
    expect(remainingArgs).toEqual({ filter: 'active', limit: '20' });
  });

  test('path params are excluded from remaining args (POST body scenario)', () => {
    const { resolvedUrl, remainingArgs } = resolveUrlPathParams({
      url: 'https://api.example.com/users/{userId}/profile',
      toolArgs: { userId: '42', name: 'Alice', email: 'alice@example.com' },
    });

    expect(resolvedUrl).toBe('https://api.example.com/users/42/profile');
    expect(remainingArgs).toEqual({
      name: 'Alice',
      email: 'alice@example.com',
    });
  });

  test('replaces all occurrences of the same placeholder', () => {
    const { resolvedUrl } = resolveUrlPathParams({
      url: 'https://api.example.com/{id}/mirror/{id}',
      toolArgs: { id: 'abc' },
    });

    expect(resolvedUrl).toBe('https://api.example.com/abc/mirror/abc');
  });
});
