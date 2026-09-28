import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { isPublishedTool } from 'src/lib/publishedTools';
import type { ResourceScope } from 'src/lib/resourceAccessor';
import { tools } from 'src/lib/tools';

import {
  requireAuth,
  requireProjectAccess,
  resolveWriteProjectId,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

/**
 * Every `/tools/:tool_id` route authorizes against the tool's own SRN.
 *
 * `tools:CallTool` is why this module went first: the route *executes*, and
 * `approvals.ts` has always checked `CallTool` against the tool's SRN.
 */
const toolAccess = makeItemRouteAuthorizer({
  findScope: tools.findScope,
  resourceType: 'tool',
  param: 'tool_id',
  label: 'Tool',
});

export type ToolUse = {
  /** Whether the caller acts from the tool's own project. */
  owned: boolean;
  /** The project the use is made from: metered to and gated by. */
  callingProjectId: number;
  projectIds: number[];
};

type ToolUseAction = 'tools:GetTool' | 'tools:CallTool';

const ownedUse = async (args: {
  ctx: Context;
  action: ToolUseAction;
  scope: ResourceScope | null;
  callingProjectPublicId?: string;
}): Promise<ToolUse> => {
  const id = args.ctx.params.tool_id;
  const namesOtherProject =
    args.callingProjectPublicId !== undefined &&
    args.callingProjectPublicId !== args.scope?.projectPublicId;
  if (args.scope !== null && namesOtherProject) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Tool '${id}' not found.`);
  }
  const access = await toolAccess.authorize({
    ctx: args.ctx,
    action: args.action,
    onDenied: args.action === 'tools:GetTool' ? 'hide' : 'refuse',
  });
  return {
    owned: true,
    callingProjectId: access.projectIds[0],
    projectIds: access.projectIds,
  };
};

const callingProjectIdFor = async (args: {
  ctx: Context;
  action: ToolUseAction;
  projectPublicId: string;
}): Promise<number> => {
  const scoped = { ...args, resourceType: 'tool' };
  if (args.action === 'tools:CallTool') return resolveWriteProjectId(scoped);
  const projectIds = await requireProjectAccess(scoped);
  return (projectIds ?? [])[0];
};

/**
 * Authorizes a read or a call of `/tools/:tool_id` and names the project it is
 * made from: `project_id`, else the credential's own project.
 *
 * From the tool's own project the tool's SRN decides, as for any resource. From
 * another one the tool must be published, and `action` is authorized in the
 * calling project instead. An unpublished tool named from another project is
 * `404`, like any resource the caller cannot reach.
 */
export const authorizeToolUse = async (args: {
  ctx: Context;
  action: ToolUseAction;
  callingProjectPublicId?: string;
}): Promise<ToolUse> => {
  const { ctx } = args;
  requireAuth(ctx);
  const id = ctx.params.tool_id;
  const scope = await tools.findScope({ id });
  const calling =
    args.callingProjectPublicId ??
    ctx.authUser.apiKeyProjectPublicId ??
    ctx.authUser.oauthProjectPublicId;

  const crossProject =
    scope !== null &&
    calling !== undefined &&
    calling !== scope.projectPublicId &&
    (await isPublishedTool({ id }));
  if (!crossProject || calling === undefined) {
    return ownedUse({ ...args, scope });
  }

  const callingProjectId = await callingProjectIdFor({
    ctx,
    action: args.action,
    projectPublicId: calling,
  });
  return { owned: false, callingProjectId, projectIds: [callingProjectId] };
};

/**
 * Authorizes a write of `/tools/:tool_id`. A published tool's existence is
 * public, so a caller the tool's SRN refuses is told `403` rather than `404`.
 */
export const authorizeToolWrite = async (args: {
  ctx: Context;
  action: 'tools:UpdateTool' | 'tools:DeleteTool';
}): Promise<{ projectIds: number[] }> => {
  const published = await isPublishedTool({ id: args.ctx.params.tool_id });
  return toolAccess.authorize({
    ctx: args.ctx,
    action: args.action,
    onDenied: published ? 'refuse-visible' : 'refuse',
  });
};
