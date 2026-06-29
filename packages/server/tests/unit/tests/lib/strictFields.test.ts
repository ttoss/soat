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
  authUser?: Context['authUser'];
}): Context => {
  return {
    method: args.method,
    path: args.path,
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
      body: { aiProviderId: 'aip_1', knowledgeConfig: { bogus: true } },
      authUser,
    });

    const { next, thrown } = await run(ctx);

    expect(next).not.toHaveBeenCalled();
    expect(
      (thrown as { meta?: { unknownFields?: string[] } }).meta?.unknownFields
    ).toEqual(['knowledgeConfig.bogus']);
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
});
