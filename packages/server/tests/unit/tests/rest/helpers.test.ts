import { DomainError } from 'src/errors';
import {
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from 'src/rest/v1/helpers';

/** Resolves to the rejection reason, so a throw can be asserted on. */
const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  return promise.then(
    () => {
      throw new Error('expected the call to throw, but it resolved');
    },
    (error: unknown) => {
      return error;
    }
  );
};

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

  test('throws VALIDATION_FAILED when no projectId and no scoped token', async () => {
    const ctx = makeCtx({
      resolveProjectIds: jest.fn().mockResolvedValue([]),
    });

    const err = await rejection(
      resolveWriteProjectId({ ctx, action: 'test:Create' })
    );

    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('VALIDATION_FAILED');
    expect((err as DomainError).httpStatus).toBe(400);
  });

  test('throws FORBIDDEN when resolveProjectIds returns null', async () => {
    const ctx = makeCtx({
      apiKeyProjectPublicId: 'proj_apikey',
      resolveProjectIds: jest.fn().mockResolvedValue(null),
    });

    const err = await rejection(
      resolveWriteProjectId({ ctx, action: 'test:Create' })
    );

    expect((err as DomainError).code).toBe('FORBIDDEN');
    expect((err as DomainError).httpStatus).toBe(403);
  });

  test('throws UNAUTHORIZED before anything else when unauthenticated', async () => {
    const ctx = { authUser: undefined } as never;

    const err = await rejection(
      resolveWriteProjectId({ ctx, action: 'test:Create' })
    );

    expect((err as DomainError).code).toBe('UNAUTHORIZED');
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

describe('requireAuth', () => {
  test('passes through when authUser is present', () => {
    const ctx = { authUser: { publicId: 'user_1' } } as never;
    expect(() => {
      return requireAuth(ctx);
    }).not.toThrow();
  });

  test('throws UNAUTHORIZED rather than writing a response', () => {
    const ctx = { authUser: undefined } as never;

    expect(() => {
      return requireAuth(ctx);
    }).toThrow(DomainError);

    // The guard must leave the response alone — the error middleware owns it.
    expect((ctx as never as { status?: number }).status).toBeUndefined();
    expect((ctx as never as { body?: unknown }).body).toBeUndefined();
  });
});

describe('resolveReadProjectIds', () => {
  test('throws FORBIDDEN when resolveProjectIds returns null', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue(null) },
    } as never;

    const err = await rejection(
      resolveReadProjectIds({ ctx, action: 'test:Action' })
    );

    expect((err as DomainError).code).toBe('FORBIDDEN');
    expect((err as DomainError).httpStatus).toBe(403);
  });

  test('returns project IDs when resolveProjectIds succeeds', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue([1, 2]) },
    } as never;

    expect(await resolveReadProjectIds({ ctx, action: 'test:Action' })).toEqual(
      [1, 2]
    );
  });

  test('passes an empty scope through — a list route answers []', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue([]) },
    } as never;

    expect(await resolveReadProjectIds({ ctx, action: 'test:Action' })).toEqual(
      []
    );
  });

  test('passes an undefined scope through — an admin JWT is unrestricted', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue(undefined) },
    } as never;

    expect(
      await resolveReadProjectIds({ ctx, action: 'test:Action' })
    ).toBeUndefined();
  });

  test('throws API_KEY_PROJECT_SCOPE when explicit projectId differs from the api key scope', async () => {
    const resolveProjectIds = jest.fn();
    const ctx = {
      authUser: { apiKeyProjectPublicId: 'proj_A', resolveProjectIds },
    } as never;

    const err = await rejection(
      resolveReadProjectIds({
        ctx,
        projectPublicId: 'proj_B',
        action: 'secrets:ListSecrets',
      })
    );

    expect((err as DomainError).code).toBe('API_KEY_PROJECT_SCOPE');
    expect(resolveProjectIds).not.toHaveBeenCalled();
  });
});

/**
 * The one behavioural difference between the two read preambles. Getting it
 * backwards turns an authorization failure into a `404` (empty scope treated as
 * "no filter") or an empty list into a `403` — which is why it is pinned here
 * rather than left to the individual routes that used to inline it.
 */
describe('requireProjectAccess', () => {
  test('rejects an empty scope that resolveReadProjectIds allows', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue([]) },
    } as never;

    const err = await rejection(
      requireProjectAccess({ ctx, action: 'test:Action' })
    );

    expect((err as DomainError).code).toBe('FORBIDDEN');
  });

  test('still allows an undefined scope — an admin JWT is unrestricted', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue(undefined) },
    } as never;

    expect(
      await requireProjectAccess({ ctx, action: 'test:Action' })
    ).toBeUndefined();
  });

  test('returns a non-empty scope unchanged', async () => {
    const ctx = {
      authUser: { resolveProjectIds: jest.fn().mockResolvedValue([3]) },
    } as never;

    expect(await requireProjectAccess({ ctx, action: 'test:Action' })).toEqual([
      3,
    ]);
  });
});
