import { callerDenied } from 'src/lib/authorizationDenial';
import { buildProjectGroupSrn } from 'src/lib/projectGroupActions';
import { findProjectGroup, projectGroupNotFound } from 'src/lib/projectGroups';
import { admitAuthorized } from 'src/middleware/admission';
import { recordAuthorizationDecision } from 'src/middleware/audit';

import type { AuthenticatedContext } from './helpers';

/**
 * The project group `projectGroupPublicId` names, once the caller may take
 * `action` on `resource` of it: `404` when it may not even read the project
 * group, `403` otherwise.
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
    const readable =
      action !== 'project-groups:GetProjectGroup' &&
      (await ctx.authUser.isAllowedOnProjectGroup({
        projectGroupPublicId,
        action: 'project-groups:GetProjectGroup',
        resource: buildProjectGroupSrn({ projectGroupPublicId }),
      }));
    if (!readable) throw projectGroupNotFound();
    throw callerDenied({ authUser: ctx.authUser, action, resource });
  }
  await admitAuthorized(ctx, action);
  return group;
};
