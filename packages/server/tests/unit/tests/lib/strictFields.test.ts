import type { Context } from 'src/Context';

type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

type StrictFieldsModule = {
  strictFieldsMiddleware: Middleware;
  STRICT_FIELDS_OPT_OUT: ReadonlySet<string>;
};

const { strictFieldsMiddleware, STRICT_FIELDS_OPT_OUT } = jest.requireActual(
  'src/middleware/strictFields'
) as StrictFieldsModule;

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
   * The query-string half. The accepted names are the spec operation's own
   * `parameters`, so these pin the wiring rather than a list: a path template
   * the middleware never matches would fail open and silently restore the
   * ignore-and-answer-wrong behavior.
   */
  describe('query parameters', () => {
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

    test('rejects an unknown parameter on any documented route', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/api/v1/projects',
        query: { bogus: 'yes' },
        authUser,
      });

      const { next, thrown } = await run(ctx);

      expect(next).not.toHaveBeenCalled();
      expect((thrown as { code?: string }).code).toBe('VALIDATION_FAILED');
    });

    test('resolves a parameterized path to its template', async () => {
      const rejected = await run(
        makeCtx({
          method: 'GET',
          path: '/api/v1/agents/agt_abc123',
          query: { bogus: 'yes' },
          authUser,
        })
      );
      expect(rejected.next).not.toHaveBeenCalled();
      expect((rejected.thrown as { code?: string }).code).toBe(
        'VALIDATION_FAILED'
      );

      const accepted = await run(
        makeCtx({
          method: 'GET',
          path: '/api/v1/sessions/sess_abc123/forks',
          query: { limit: '5' },
          authUser,
        })
      );
      expect(accepted.thrown).toBeUndefined();
      expect(accepted.next).toHaveBeenCalledTimes(1);
    });

    // The query string is checked on writes too: `?wait=true` decides whether
    // a generation route answers with the finished record or a handle, so a
    // typo there silently changes the response shape rather than the filter.
    test('checks mutating routes, not only reads', async () => {
      const accepted = await run(
        makeCtx({
          method: 'POST',
          path: '/api/v1/agents/agt_abc123/generate',
          query: { wait: 'true' },
          authUser,
        })
      );
      expect(accepted.thrown).toBeUndefined();

      const rejected = await run(
        makeCtx({
          method: 'POST',
          path: '/api/v1/agents/agt_abc123/generate',
          query: { waite: 'true' },
          authUser,
        })
      );
      expect((rejected.thrown as { code?: string }).code).toBe(
        'VALIDATION_FAILED'
      );
    });

    test('leaves a path the spec documents no operation for alone', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/api/v1/openapi.json',
        query: { bogus: 'yes' },
        authUser,
      });

      const { next, thrown } = await run(ctx);

      expect(thrown).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('leaves paths outside /api/v1 alone', async () => {
      const ctx = makeCtx({
        method: 'GET',
        path: '/hooks/inbound/whatever',
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
