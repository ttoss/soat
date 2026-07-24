import { DomainError } from 'src/errors';
import {
  checkAuth,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from 'src/rest/v1/helpers';

describe('resolveWriteProjectId', () => {
  const makeCtx = (authUser: Record<string, unknown>) => {
    return { authUser } as never;
  };

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

  test('throws API_KEY_PROJECT_SCOPE when explicit projectId differs from the api key scope', async () => {
    const resolveProjectIds = jest.fn();
    const ctx = makeCtx({ apiKeyProjectPublicId: 'proj_A', resolveProjectIds });

    const err = await resolveWriteProjectId({
      ctx,
      projectPublicId: 'proj_B',
      action: 'secrets:CreateSecret',
    }).catch((error: unknown) => {
      return error;
    });

    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('API_KEY_PROJECT_SCOPE');
    expect((err as DomainError).httpStatus).toBe(403);
    expect((err as DomainError).message).toContain('proj_A');
    expect((err as DomainError).message).toContain('proj_B');
    expect((err as DomainError).meta).toMatchObject({
      scoped_project: 'proj_A',
      requested_project: 'proj_B',
    });
    // Short-circuits before touching the policy engine.
    expect(resolveProjectIds).not.toHaveBeenCalled();
  });

  test('throws API_KEY_PROJECT_SCOPE when explicit projectId differs from the oauth token scope', async () => {
    const ctx = makeCtx({
      oauthProjectPublicId: 'proj_A',
      resolveProjectIds: jest.fn(),
    });

    const err = await resolveWriteProjectId({
      ctx,
      projectPublicId: 'proj_B',
      action: 'secrets:CreateSecret',
    }).catch((error: unknown) => {
      return error;
    });

    expect((err as DomainError).code).toBe('API_KEY_PROJECT_SCOPE');
  });

  test('does not throw when explicit projectId matches the scope', async () => {
    const ctx = makeCtx({
      apiKeyProjectPublicId: 'proj_A',
      resolveProjectIds: jest.fn().mockResolvedValue([5]),
    });
    const result = await resolveWriteProjectId({
      ctx,
      projectPublicId: 'proj_A',
      action: 'test:Create',
    });
    expect(result).toBe(5);
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

  test('throws API_KEY_PROJECT_SCOPE when explicit projectId differs from the api key scope', async () => {
    const resolveProjectIds = jest.fn();
    const ctx = {
      authUser: { apiKeyProjectPublicId: 'proj_A', resolveProjectIds },
    } as never;

    const err = await resolveProjectIdsWithAction({
      ctx,
      projectPublicId: 'proj_B',
      action: 'secrets:ListSecrets',
    }).catch((error: unknown) => {
      return error;
    });

    expect((err as DomainError).code).toBe('API_KEY_PROJECT_SCOPE');
    expect(resolveProjectIds).not.toHaveBeenCalled();
  });
});
