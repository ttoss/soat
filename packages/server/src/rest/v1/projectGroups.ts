import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { callerDenied } from 'src/lib/authorizationDenial';
import { buildProjectGroupSrn } from 'src/lib/projectGroupActions';
import {
  addProjectGroupProject,
  createProjectGroup,
  createProjectGroupProject,
  deleteProjectGroup,
  findProjectGroup,
  getProjectGroup,
  listProjectGroups,
  projectGroupNotFound,
  removeProjectGroupProject,
  updateProjectGroup,
} from 'src/lib/projectGroups';
import { admitAuthorized } from 'src/middleware/admission';
import { recordAuthorizationDecision } from 'src/middleware/audit';

import {
  type AuthenticatedContext,
  parsePagination,
  requireAdmin,
  requireAuth,
} from './helpers';

const projectGroupsRouter = new Router<Context>();

/**
 * The project group the path names, once the caller may take `action` on `resource`
 * of it: `404` when it may not even read the project group, `403` otherwise.
 */
const authorizeProjectGroup = async (args: {
  ctx: AuthenticatedContext;
  action: string;
  /** The project group resource type the action is on; the whole project group when absent. */
  projectGroupType?: string;
}) => {
  const { ctx, action } = args;
  const group = await findProjectGroup({
    publicId: ctx.params.project_group_id,
  });
  const projectGroupPublicId = group.publicId as string;
  const resource = buildProjectGroupSrn({
    projectGroupPublicId,
    resourceType: args.projectGroupType,
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

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.post('/project-groups', async (ctx: Context) => {
  await requireAdmin(ctx, 'project-groups:CreateProjectGroup');
  const body = ctx.request.body as Record<string, unknown>;
  ctx.status = 201;
  ctx.body = await createProjectGroup({
    name: body.name,
    ownerId: body.owner_id,
    policyIds: body.policy_ids,
    fixedPolicyIds: body.fixed_policy_ids,
    writer: ctx.authUser!,
  });
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.get('/project-groups', async (ctx: Context) => {
  requireAuth(ctx);
  // Self-service: the list holds only what the caller may read.
  recordAuthorizationDecision(ctx, {
    action: 'project-groups:ListProjectGroups',
    allowed: true,
  });
  if (ctx.authUser.unrestricted) {
    ctx.body = await listProjectGroups(parsePagination(ctx));
    return;
  }
  const page = await listProjectGroups({
    ownerUserId: ctx.authUser.id ?? -1,
    ...parsePagination(ctx),
  });
  const readable = await Promise.all(
    page.data.map((group) => {
      return ctx.authUser.isAllowedOnProjectGroup({
        projectGroupPublicId: group.id,
        action: 'project-groups:GetProjectGroup',
        resource: buildProjectGroupSrn({ projectGroupPublicId: group.id }),
      });
    })
  );
  ctx.body = {
    ...page,
    data: page.data.filter((_group, index) => {
      return readable[index];
    }),
  };
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.get(
  '/project-groups/:project_group_id',
  async (ctx: Context) => {
    requireAuth(ctx);
    const group = await authorizeProjectGroup({
      ctx,
      action: 'project-groups:GetProjectGroup',
    });
    ctx.body = await getProjectGroup({ publicId: group.publicId as string });
  }
);

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.patch(
  '/project-groups/:project_group_id',
  async (ctx: Context) => {
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;
    // The operator's policies cap the project group whatever its owner holds.
    if (body.fixed_policy_ids !== undefined) {
      await requireAdmin(ctx, 'project-groups:UpdateProjectGroup');
    }
    const group = await authorizeProjectGroup({
      ctx,
      action: 'project-groups:UpdateProjectGroup',
    });
    ctx.body = await updateProjectGroup({
      group,
      name: body.name,
      policyIds: body.policy_ids,
      fixedPolicyIds: body.fixed_policy_ids,
      writer: ctx.authUser,
    });
  }
);

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.delete(
  '/project-groups/:project_group_id',
  async (ctx: Context) => {
    await requireAdmin(ctx, 'project-groups:DeleteProjectGroup');
    await deleteProjectGroup({
      group: await findProjectGroup({ publicId: ctx.params.project_group_id }),
    });
    ctx.status = 204;
  }
);

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.post(
  '/project-groups/:project_group_id/projects',
  async (ctx: Context) => {
    requireAuth(ctx);
    const group = await authorizeProjectGroup({
      ctx,
      action: 'project-groups:CreateProject',
      projectGroupType: 'project',
    });
    const body = ctx.request.body as Record<string, unknown>;
    ctx.status = 201;
    ctx.body = await createProjectGroupProject({ group, name: body.name });
  }
);

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.put(
  '/project-groups/:project_group_id/projects/:project_id',
  async (ctx: Context) => {
    await requireAdmin(ctx, 'project-groups:AddProjectGroupProject');
    await addProjectGroupProject({
      group: await findProjectGroup({ publicId: ctx.params.project_group_id }),
      projectPublicId: ctx.params.project_id,
    });
    ctx.status = 204;
  }
);

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/project-groups.yaml
 */
projectGroupsRouter.delete(
  '/project-groups/:project_group_id/projects/:project_id',
  async (ctx: Context) => {
    await requireAdmin(ctx, 'project-groups:RemoveProjectGroupProject');
    await removeProjectGroupProject({
      group: await findProjectGroup({ publicId: ctx.params.project_group_id }),
      projectPublicId: ctx.params.project_id,
    });
    ctx.status = 204;
  }
);

export { projectGroupsRouter };
