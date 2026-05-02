import {
  checkAuth,
  checkProjectId,
  checkResourcePermission,
  getTargetProjectId,
  resolveProjectIdsWithAction,
} from 'src/rest/v1/helpers';

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
