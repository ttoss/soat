/**
 * Common helper functions for REST API handlers
 */
import type { Context } from 'src/Context';

/**
 * Checks if user is authenticated and returns error response if not
 */
export const checkAuth = (ctx: Context): boolean => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return false;
  }
  return true;
};

/**
 * Resolves project IDs for an action with permission check
 */
export const resolveProjectIdsWithAction = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
}): Promise<number[] | null | undefined> => {
  // Every call site runs this after `checkAuth(ctx)`, so `ctx.authUser` is
  // always defined here.
  const projectIds = await args.ctx.authUser!.resolveProjectIds({
    projectPublicId: args.projectPublicId,
    action: args.action,
  });

  if (projectIds === null) {
    args.ctx.status = 403;
    args.ctx.body = { error: 'Forbidden' };
    return null;
  }

  return projectIds;
};

/**
 * Resolves the numeric project id for a create/write operation.
 *
 * - An explicit `projectPublicId` is used as-is, subject to the permission check.
 * - When omitted, a project-scoped API key or project-scoped OAuth token supplies its
 *   own project automatically (implicit project id).
 * - A scoped credential with an explicit `projectPublicId` that does not match the
 *   credential's project resolves to 403.
 * - When omitted without a scoped credential (e.g. plain JWT auth), responds 400 —
 *   a write needs a concrete project and one is never inferred from a JWT user's
 *   accessible projects.
 *
 * Returns the numeric project id, or `null` when a response (401/400/403) has already
 * been set on `ctx` and the caller should `return`.
 */
export const resolveWriteProjectId = async (args: {
  ctx: Context;
  projectPublicId?: string;
  action: string;
}): Promise<number | null> => {
  const { ctx, action } = args;
  // Every call site runs this after `checkAuth(ctx)`, so `ctx.authUser` is
  // always defined here.
  const authUser = ctx.authUser!;

  // Without an explicit project id, a project-scoped API key or OAuth token supplies a default.
  const projectPublicId =
    args.projectPublicId ??
    authUser.apiKeyProjectPublicId ??
    authUser.oauthProjectPublicId;

  if (!projectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return null;
  }

  // resolveProjectIds runs the permission check and, for a scoped key, returns null
  // when projectPublicId does not match the key's project (→ 403). Every
  // resolveProjectIds implementation, given a truthy projectPublicId (guaranteed
  // above), either returns null or a single-element array — so the resolved id is
  // always defined here.
  const projectIds = await authUser.resolveProjectIds({
    projectPublicId,
    action,
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  return projectIds![0];
};
