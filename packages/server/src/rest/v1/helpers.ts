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
  if (!args.ctx.authUser) {
    return null;
  }
  const projectIds = await args.ctx.authUser.resolveProjectIds({
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
 * Gets the target project ID (from resolved list or API key project)
 */
export const getTargetProjectId = (args: {
  projectIds?: number[];
  apiKeyProjectId?: number;
}): number | null => {
  const targetProjectId = args.projectIds?.[0] ?? args.apiKeyProjectId;
  return targetProjectId ?? null;
};

/**
 * Returns error response if no target project ID
 */
export const checkProjectId = (args: {
  ctx: Context;
  projectId: number | null;
}): boolean => {
  if (!args.projectId) {
    args.ctx.status = 400;
    args.ctx.body = { error: 'projectId is required' };
    return false;
  }
  return true;
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }

  // Without an explicit project id, a project-scoped API key or OAuth token supplies a default.
  const projectPublicId =
    args.projectPublicId ??
    ctx.authUser.apiKeyProjectPublicId ??
    ctx.authUser.oauthProjectPublicId;

  if (!projectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return null;
  }

  // resolveProjectIds runs the permission check and, for a scoped key, returns null
  // when projectPublicId does not match the key's project (→ 403).
  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action,
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  const targetProjectId =
    projectIds?.[0] ?? ctx.authUser.apiKeyProjectId ?? null;

  if (targetProjectId === null) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return null;
  }

  return targetProjectId;
};

/**
 * Validates that a user has permission to access a resource
 */
export const checkResourcePermission = (args: {
  ctx: Context;
  resourceUserId: string;
  adminOnly?: boolean;
}): boolean => {
  const isOwner = args.resourceUserId === args.ctx.authUser?.publicId;
  const isAdmin = args.ctx.authUser?.role === 'admin';

  if (!isOwner && !isAdmin) {
    args.ctx.status = 403;
    args.ctx.body = { error: 'Forbidden' };
    return false;
  }

  return true;
};
