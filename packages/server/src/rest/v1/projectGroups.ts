import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildProjectGroupSrn } from 'src/lib/projectGroupActions';
import {
  addProjectGroupProject,
  createProjectGroup,
  createProjectGroupProject,
  deleteProjectGroup,
  findProjectGroup,
  getProjectGroup,
  listProjectGroups,
  removeProjectGroupProject,
  updateProjectGroup,
} from 'src/lib/projectGroups';
import { admitAuthorized } from 'src/middleware/admission';
import { recordAuthorizationDecision } from 'src/middleware/audit';

import { parsePagination, requireAdmin, requireAuth } from './helpers';
import { authorizeProjectGroup } from './projectGroupAccess';

const projectGroupsRouter = new Router<Context>();

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
  await admitAuthorized(ctx, 'project-groups:ListProjectGroups');
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
      projectGroupPublicId: ctx.params.project_group_id,
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
      projectGroupPublicId: ctx.params.project_group_id,
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
      projectGroupPublicId: ctx.params.project_group_id,
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
