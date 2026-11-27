import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { callerDenied } from 'src/lib/authorizationDenial';
import { buildGroupSrn } from 'src/lib/groupActions';
import {
  addGroupProject,
  createGroup,
  createGroupProject,
  deleteGroup,
  findGroup,
  getGroup,
  listGroups,
  removeGroupProject,
  updateGroup,
} from 'src/lib/groups';
import { admitAuthorized } from 'src/middleware/admission';
import { recordAuthorizationDecision } from 'src/middleware/audit';

import {
  type AuthenticatedContext,
  parsePagination,
  requireAdmin,
  requireAuth,
} from './helpers';

const groupsRouter = new Router<Context>();

/**
 * The group the path names, once the caller may take `action` on `resource`
 * of it: `404` when it may not even read the group, `403` otherwise.
 */
const authorizeGroup = async (args: {
  ctx: AuthenticatedContext;
  action: string;
  /** The group resource type the action is on; the whole group when absent. */
  groupType?: string;
}) => {
  const { ctx, action } = args;
  const group = await findGroup({ publicId: ctx.params.group_id });
  const groupPublicId = group.publicId as string;
  const resource = buildGroupSrn({
    groupPublicId,
    resourceType: args.groupType,
  });
  const allowed = await ctx.authUser.isAllowedOnGroup({
    groupPublicId,
    action,
    resource,
  });
  recordAuthorizationDecision(ctx, { action, allowed });
  if (!allowed) {
    const readable =
      action !== 'groups:GetGroup' &&
      (await ctx.authUser.isAllowedOnGroup({
        groupPublicId,
        action: 'groups:GetGroup',
        resource: buildGroupSrn({ groupPublicId }),
      }));
    if (!readable)
      throw new DomainError('RESOURCE_NOT_FOUND', 'Group not found');
    throw callerDenied({ authUser: ctx.authUser, action, resource });
  }
  await admitAuthorized(ctx, action);
  return group;
};

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.post('/groups', async (ctx: Context) => {
  await requireAdmin(ctx, 'groups:CreateGroup');
  const body = ctx.request.body as Record<string, unknown>;
  ctx.status = 201;
  ctx.body = await createGroup({
    name: body.name,
    ownerId: body.owner_id,
    policyIds: body.policy_ids,
    fixedPolicyIds: body.fixed_policy_ids,
    writer: ctx.authUser!,
  });
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.get('/groups', async (ctx: Context) => {
  requireAuth(ctx);
  // Self-service: the list holds only what the caller may read.
  recordAuthorizationDecision(ctx, {
    action: 'groups:ListGroups',
    allowed: true,
  });
  if (ctx.authUser.unrestricted) {
    ctx.body = await listGroups(parsePagination(ctx));
    return;
  }
  const page = await listGroups({
    ownerUserId: ctx.authUser.id ?? -1,
    ...parsePagination(ctx),
  });
  const readable = await Promise.all(
    page.data.map((group) => {
      return ctx.authUser.isAllowedOnGroup({
        groupPublicId: group.id,
        action: 'groups:GetGroup',
        resource: buildGroupSrn({ groupPublicId: group.id }),
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
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.get('/groups/:group_id', async (ctx: Context) => {
  requireAuth(ctx);
  const group = await authorizeGroup({ ctx, action: 'groups:GetGroup' });
  ctx.body = await getGroup({ publicId: group.publicId as string });
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.patch('/groups/:group_id', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as Record<string, unknown>;
  // The operator's policies cap the group whatever its owner holds.
  if (body.fixed_policy_ids !== undefined) {
    await requireAdmin(ctx, 'groups:UpdateGroup');
  }
  const group = await authorizeGroup({ ctx, action: 'groups:UpdateGroup' });
  ctx.body = await updateGroup({
    group,
    name: body.name,
    policyIds: body.policy_ids,
    fixedPolicyIds: body.fixed_policy_ids,
    writer: ctx.authUser,
  });
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.delete('/groups/:group_id', async (ctx: Context) => {
  await requireAdmin(ctx, 'groups:DeleteGroup');
  await deleteGroup({
    group: await findGroup({ publicId: ctx.params.group_id }),
  });
  ctx.status = 204;
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.post('/groups/:group_id/projects', async (ctx: Context) => {
  requireAuth(ctx);
  const group = await authorizeGroup({
    ctx,
    action: 'groups:CreateProject',
    groupType: 'project',
  });
  const body = ctx.request.body as Record<string, unknown>;
  ctx.status = 201;
  ctx.body = await createGroupProject({ group, name: body.name });
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.put(
  '/groups/:group_id/projects/:project_id',
  async (ctx: Context) => {
    await requireAdmin(ctx, 'groups:AddGroupProject');
    await addGroupProject({
      group: await findGroup({ publicId: ctx.params.group_id }),
      projectPublicId: ctx.params.project_id,
    });
    ctx.status = 204;
  }
);

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/groups.yaml
 */
groupsRouter.delete(
  '/groups/:group_id/projects/:project_id',
  async (ctx: Context) => {
    await requireAdmin(ctx, 'groups:RemoveGroupProject');
    await removeGroupProject({
      group: await findGroup({ publicId: ctx.params.group_id }),
      projectPublicId: ctx.params.project_id,
    });
    ctx.status = 204;
  }
);

export { groupsRouter };
