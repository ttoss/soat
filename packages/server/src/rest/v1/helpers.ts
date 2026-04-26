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
