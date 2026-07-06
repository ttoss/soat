import {
  checkAuth,
  checkProjectId,
  checkResourcePermission,
  getTargetProjectId,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from 'src/rest/v1/helpers';

describe('resolveWriteProjectId', () => {
  const makeCtx = (authUser: Record<string, unknown>) => {
    return { authUser } as never;
  };

  test('returns 401 when no authUser', async () => {
    const ctx = { authUser: undefined } as never;
    const result = await resolveWriteProjectId({ ctx, action: 'test:Create' });
    expect(result).toBeNull();
    expect((ctx as never as { status: number }).status).toBe(401);
  });

  test('uses explicit projectPublicId', async () => {
    const ctx = makeCtx({
      resolveProjectIds: jest.fn().mockResolvedValue([42]),
    });
    const result = await resolveWriteProjectId({
      ctx,
      projectPublicId: 'proj_explicit',
      action: 'test:Create',
    });
    expect(result).toBe(42);
  });

  test('falls back to apiKeyProjectPublicId when no explicit projectId', async () => {
    const ctx = makeCtx({
      apiKeyProjectPublicId: 'proj_apikey',
      resolveProjectIds: jest.fn().mockResolvedValue([7]),
    });
    const result = await resolveWriteProjectId({ ctx, action: 'test:Create' });
    expect(result).toBe(7);
  });

  test('falls back to oauthProjectPublicId when no explicit projectId and no apiKey', async () => {
    const ctx = makeCtx({
      oauthProjectPublicId: 'proj_oauth',
      resolveProjectIds: jest.fn().mockResolvedValue([9]),
    });
    const result = await resolveWriteProjectId({ ctx, action: 'test:Create' });
    expect(result).toBe(9);
  });

  test('returns 400 when no projectId and no scoped token', async () => {
    const ctx = makeCtx({
      resolveProjectIds: jest.fn().mockResolvedValue([]),
    });
    const result = await resolveWriteProjectId({ ctx, action: 'test:Create' });
    expect(result).toBeNull();
    expect((ctx as never as { status: number }).status).toBe(400);
  });

  test('returns 403 when resolveProjectIds returns null', async () => {
    const ctx = makeCtx({
      apiKeyProjectPublicId: 'proj_apikey',
      resolveProjectIds: jest.fn().mockResolvedValue(null),
    });
    const result = await resolveWriteProjectId({ ctx, action: 'test:Create' });
    expect(result).toBeNull();
    expect((ctx as never as { status: number }).status).toBe(403);
  });
});

describe('checkAuth', () => {
  test('returns true when authUser is present', () => {
    const ctx = { authUser: { publicId: 'user_1' } } as never;
    expect(checkAuth(ctx)).toBe(true);
  });

  test('returns false and sets 401 when no authUser', () => {
    const ctx = { authUser: undefined } as never;
    expect(checkAuth(ctx)).toBe(false);
    expect((ctx as never as { status: number }).status).toBe(401);
    expect((ctx as never as { body: unknown }).body).toEqual({
      error: 'Unauthorized',
    });
  });
});

describe('resolveProjectIdsWithAction', () => {
  test('returns null when no authUser', async () => {
    const ctx = { authUser: undefined } as never;
    const result = await resolveProjectIdsWithAction({
      ctx,
      action: 'test:Action',
    });
    expect(result).toBeNull();
  });

  test('sets 403 and returns null when resolveProjectIds returns null', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue(null) },
    } as never;
    const result = await resolveProjectIdsWithAction({
      ctx,
      action: 'test:Action',
    });
    expect(result).toBeNull();
    expect((ctx as never as { status: number }).status).toBe(403);
    expect((ctx as never as { body: unknown }).body).toEqual({
      error: 'Forbidden',
    });
  });

  test('returns project IDs when resolveProjectIds succeeds', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue([1, 2]) },
    } as never;
    const result = await resolveProjectIdsWithAction({
      ctx,
      action: 'test:Action',
    });
    expect(result).toEqual([1, 2]);
  });
});

describe('getTargetProjectId', () => {
  test('returns first projectId when available', () => {
    expect(getTargetProjectId({ projectIds: [5, 6] })).toBe(5);
  });

  test('falls back to apiKeyProjectId when no projectIds', () => {
    expect(getTargetProjectId({ apiKeyProjectId: 3 })).toBe(3);
  });

  test('returns null when nothing provided', () => {
    expect(getTargetProjectId({})).toBeNull();
  });
});

describe('checkProjectId', () => {
  test('returns true when projectId is set', () => {
    const ctx = {} as never;
    expect(checkProjectId({ ctx, projectId: 1 })).toBe(true);
  });

  test('returns false and sets 400 when projectId is null', () => {
    const ctx = {} as never;
    expect(checkProjectId({ ctx, projectId: null })).toBe(false);
    expect((ctx as never as { status: number }).status).toBe(400);
    expect((ctx as never as { body: unknown }).body).toEqual({
      error: 'projectId is required',
    });
  });
});

describe('checkResourcePermission', () => {
  test('returns true when user is the resource owner', () => {
    const ctx = {
      authUser: { publicId: 'user_1', role: 'user' },
    } as never;
    expect(checkResourcePermission({ ctx, resourceUserId: 'user_1' })).toBe(
      true
    );
  });

  test('returns true when user is admin', () => {
    const ctx = {
      authUser: { publicId: 'user_2', role: 'admin' },
    } as never;
    expect(checkResourcePermission({ ctx, resourceUserId: 'user_1' })).toBe(
      true
    );
  });

  test('returns false and sets 403 when not owner or admin', () => {
    const ctx = {
      authUser: { publicId: 'user_2', role: 'user' },
    } as never;
    expect(checkResourcePermission({ ctx, resourceUserId: 'user_1' })).toBe(
      false
    );
    expect((ctx as never as { status: number }).status).toBe(403);
    expect((ctx as never as { body: unknown }).body).toEqual({
      error: 'Forbidden',
    });
  });
});
