import type { Context } from 'src/Context';
import { getDeclaredQueryParams } from 'src/lib/openapiSpec';

type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

type StrictFieldsModule = {
  strictFieldsMiddleware: Middleware;
  STRICT_FIELDS_OPT_OUT: ReadonlySet<string>;
  STRICT_QUERY_ROUTES: ReadonlySet<string>;
};

const { strictFieldsMiddleware, STRICT_FIELDS_OPT_OUT, STRICT_QUERY_ROUTES } =
  jest.requireActual('src/middleware/strictFields') as StrictFieldsModule;

// Minimal authenticated user — only its presence matters to the middleware.
const authUser = { id: 1 } as unknown as Context['authUser'];

const makeCtx = (args: {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  authUser?: Context['authUser'];
}): Context => {
  return {
    method: args.method,
    path: args.path,
    query: args.query ?? {},
    authUser: args.authUser,
    request: { body: args.body },
  } as unknown as Context;
};

const run = async (ctx: Context) => {
  const next = jest.fn(async () => {});
  let thrown: unknown;
  try {
    await strictFieldsMiddleware(ctx, next);
  } catch (error) {
    thrown = error;
  }
  return { next, thrown };
};

describe('strictFieldsMiddleware', () => {
  test('rejects an unknown field on a validated route', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/api/v1/projects',
      body: { name: 'X', bogus: true },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(next).not.toHaveBeenCalled();
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('VALIDATION_FAILED');
    expect(
      (thrown as { meta?: { unknownFields?: string[] } }).meta?.unknownFields
    ).toEqual(['bogus']);
  });

  test('rejects an unknown nested field with a dotted path', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/api/v1/agents',
      body: { ai_provider_id: 'aip_1', knowledge_config: { bogus: true } },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(next).not.toHaveBeenCalled();
    expect(
      (thrown as { meta?: { unknownFields?: string[] } }).meta?.unknownFields
    ).toEqual(['knowledge_config.bogus']);
  });

  test('rejects a missing top-level required field', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/api/v1/projects',
      body: {},
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(next).not.toHaveBeenCalled();
    expect((thrown as { code?: string }).code).toBe('VALIDATION_FAILED');
    expect(
      (thrown as { meta?: { missingFields?: string[] } }).meta?.missingFields
    ).toEqual(['name']);
  });

  test('passes a body with only known fields and required present', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/api/v1/projects',
      body: { name: 'X' },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('skips unauthenticated requests so the handler can return 401', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/api/v1/projects',
      body: { name: 'X', bogus: true },
      authUser: undefined,
    });

    const { next, thrown } = await run(ctx);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('skips non-mutating methods', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/api/v1/projects',
      body: { bogus: true },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('skips opt-out passthrough routes (chat completions)', async () => {
    expect(STRICT_FIELDS_OPT_OUT.has('POST /api/v1/chat/completions')).toBe(
      true
    );

    const ctx = makeCtx({
      method: 'POST',
      path: '/api/v1/chat/completions',
      body: { messages: [], temperature: 0.7 },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('skips routes with no property-based body schema (tags map)', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/api/v1/actors/act_1/tags',
      body: { anything: 'goes' },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('skips paths outside /api/v1', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/mcp',
      body: { bogus: true },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('skips when the body is not a plain object', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/api/v1/projects',
      body: undefined,
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
  /**
   * The query-string half. Its allowlist is the spec's own `parameters`, so
   * these pin the wiring rather than the list: an entry that names no
   * operation, or a path template the middleware never matches, would fail
   * open and silently restore the ignore-and-answer-wrong behavior.
   */
  describe('query parameters', () => {
    test('every strict route names a static path with declared parameters', () => {
      expect(STRICT_QUERY_ROUTES.size).toBeGreaterThan(0);
      for (const route of STRICT_QUERY_ROUTES) {
        const [method, path] = route.split(' ');
        expect(path).not.toContain('{');
        const declared = getDeclaredQueryParams({ method, path });
        expect(declared).not.toBeNull();
        expect(declared!.size).toBeGreaterThan(0);
      }
    });

    test('rejects a parameter the route does not declare', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/api/v1/usage/aggregate',
        query: { project_id: 'proj_1', group_by: 'model', model: 'gpt-4' },
        authUser,
      });

      const { next, thrown } = await run(ctx);

      expect(next).not.toHaveBeenCalled();
      expect((thrown as { code?: string }).code).toBe('VALIDATION_FAILED');
      expect(
        (thrown as { meta?: { unknown_query_parameters?: string[] } }).meta
          ?.unknown_query_parameters
      ).toEqual(['model']);
    });

    test('passes the parameters the spec declares', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/api/v1/usage/aggregate',
        query: {
          project_id: 'proj_1',
          group_by: 'day',
          session_id: 'sess_1',
          actor_id: 'actor_1',
        },
        authUser,
      });

      const { next, thrown } = await run(ctx);

      expect(thrown).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('leaves routes that did not opt in alone', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/api/v1/projects',
        query: { bogus: 'yes' },
        authUser,
      });

      const { next, thrown } = await run(ctx);

      expect(thrown).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('skips unauthenticated requests so the handler can return 401', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/api/v1/usage/aggregate',
        query: { bogus: 'yes' },
        authUser: undefined,
      });

      const { next, thrown } = await run(ctx);

      expect(thrown).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
