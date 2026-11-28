import { callerDenied } from 'src/lib/authorizationDenial';
import { policySetsConcernProjectGroup } from 'src/lib/iam';
import { buildProjectGroupSrn } from 'src/lib/projectGroupActions';
import { findProjectGroup, projectGroupNotFound } from 'src/lib/projectGroups';
import { admitAuthorized } from 'src/middleware/admission';
import { recordAuthorizationDecision } from 'src/middleware/audit';

import type { AuthenticatedContext } from './helpers';

/**
 * Whether the project group is within the caller's reach: a key of the project
 * group, or policies that all name it, as `beyondReach` (`resourceAccess.ts`)
 * asks of a project. A key of another project group or of a project reaches none.
 */
const withinReach = async (args: {
  ctx: AuthenticatedContext;
  projectGroupPublicId: string;
}): Promise<boolean> => {
  const { authUser } = args.ctx;
  if (authUser.apiKeyProjectGroupPublicId !== undefined) {
    return authUser.apiKeyProjectGroupPublicId === args.projectGroupPublicId;
  }
  return policySetsConcernProjectGroup({
    sets: await authUser.getProjectGroupPolicies(args.projectGroupPublicId),
    projectGroupPublicId: args.projectGroupPublicId,
  });
};

/**
 * The project group `projectGroupPublicId` names, once the caller may take
 * `action` on `resource` of it: `404` when it is beyond the caller's reach,
 * `403` naming the action otherwise.
 */
export const authorizeProjectGroup = async (args: {
  ctx: AuthenticatedContext;
  projectGroupPublicId: string;
  action: string;
  /** The project group resource type the action is on; the whole project group when absent. */
  projectGroupType?: string;
  /** The one resource of that type; every one when absent. */
  resourceId?: string;
}): ReturnType<typeof findProjectGroup> => {
  const { ctx, action } = args;
  const group = await findProjectGroup({ publicId: args.projectGroupPublicId });
  const projectGroupPublicId = group.publicId as string;
  const resource = buildProjectGroupSrn({
    projectGroupPublicId,
    resourceType: args.projectGroupType,
    resourceId: args.resourceId,
  });
  const allowed = await ctx.authUser.isAllowedOnProjectGroup({
    projectGroupPublicId,
    action,
    resource,
  });
  recordAuthorizationDecision(ctx, { action, allowed });
  if (!allowed) {
    if (!(await withinReach({ ctx, projectGroupPublicId }))) {
      throw projectGroupNotFound();
    }
    throw callerDenied({ authUser: ctx.authUser, action, resource });
  }
  await admitAuthorized(ctx, action);
  return group;
};
