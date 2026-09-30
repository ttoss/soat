import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { findSharedUse } from 'src/lib/resourceReferences';

import { requireAuth } from './helpers';

/** The grantee project a call runs in, and the project owning the resource. */
export type SharedAccess = { projectId: number; ownerProjectId: number };

/**
 * The access a credential confined to one project has to another project's
 * tool or agent through an accepted share, or `null` when no share applies and
 * the route's own authorization decides.
 *
 * Only a confined credential names the project a call runs in; an unconfined
 * one reaches a shared resource through the rows of its own projects instead.
 * The caller's own policies must still allow `action` in that project.
 */
export const authorizeSharedUse = async (args: {
  ctx: Context;
  resourceType: 'tool' | 'agent';
  resourceId: string;
  action: string;
}): Promise<SharedAccess | null> => {
  const { ctx } = args;
  requireAuth(ctx);
  const projectPublicId =
    ctx.authUser.apiKeyProjectPublicId ?? ctx.authUser.oauthProjectPublicId;
  if (!projectPublicId) return null;

  const shared = await findSharedUse({
    resourceType: args.resourceType,
    id: args.resourceId,
    projectPublicId,
  });
  if (!shared) return null;

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId,
    action: args.action,
    resource: buildSrn({
      projectPublicId,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
    }),
  });
  if (!allowed) throw new DomainError('FORBIDDEN', 'Forbidden');
  return shared;
};
