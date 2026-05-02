import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createAgentTool,
  deleteAgentTool,
  getAgentTool,
  listAgentTools,
  updateAgentTool,
} from 'src/lib/agents';

export const agentToolsRouter = new Router<Context>();

const parseStringOrUndefined = (v: unknown): string | undefined => {
  return typeof v === 'string' ? v : undefined;
};

/**
 * Coerces an input value to a plain JSON object, null, or undefined.
 * Accepts already-parsed objects or JSON-encoded strings. Throws a TypeError
 * when the value is present but cannot be coerced to a plain object, so the
 * caller can return a 400 response.
 */
const coerceToJsonObject = (v: unknown): object | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as object;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return parsed as object;
      }
    } catch {
      // invalid JSON string — fall through
    }
  }
  throw new TypeError('must be a JSON object');
};

const parseNullableArray = (v: unknown): string[] | null | undefined => {
  return v !== undefined ? (v as string[] | null) : undefined;
};

const parseNullableString = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
};

const resolveToolProjectId = async (
  ctx: Context,
  action: string,
  projectPublicId?: string
): Promise<number | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action,
  });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  const targetProjectId = projectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  if (!targetProjectId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return null;
  }
  return targetProjectId!;
};

const checkToolsAccess = async (
  ctx: Context,
  action: string
): Promise<number[] | undefined | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({ action });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  return projectIds;
};

agentToolsRouter.post('/agents/tools', async (ctx: Context) => {
  const {
    name,
    type,
    description,
    parameters,
    execute,
    mcp,
    actions,
    projectId: projectPublicId,
  } = (ctx.request.body ?? {}) as {
    name?: unknown;
    type?: unknown;
    description?: unknown;
    parameters?: unknown;
    execute?: unknown;
    mcp?: unknown;
    actions?: unknown;
    projectId?: string;
  };

  if (!name || typeof name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const targetProjectId = await resolveToolProjectId(
    ctx,
    'agents:CreateAgentTool',
    projectPublicId
  );
  if (!targetProjectId) return;

  let parsedParameters: object | undefined;
  let parsedExecute: object | undefined;
  let parsedMcp: object | undefined;
  try {
    parsedParameters = coerceToJsonObject(parameters) as object | undefined;
    parsedExecute = coerceToJsonObject(execute) as object | undefined;
    parsedMcp = coerceToJsonObject(mcp) as object | undefined;
  } catch {
    ctx.status = 400;
    ctx.body = { error: 'parameters, execute, and mcp must be JSON objects' };
    return;
  }

  const result = await createAgentTool({
    projectId: Number(targetProjectId),
    name,
    type: parseStringOrUndefined(type),
    description: parseStringOrUndefined(description),
    parameters: parsedParameters,
    execute: parsedExecute,
    mcp: parsedMcp,
    actions: Array.isArray(actions) ? actions : undefined,
  });

  ctx.status = 201;
  ctx.body = result;
});

agentToolsRouter.get('/agents/tools', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:ListAgentTools',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listAgentTools({ projectIds });
});

agentToolsRouter.get('/agents/tools/:tool_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetAgentTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getAgentTool({
    projectIds,
    id: ctx.params.tool_id,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent tool not found' };
    return;
  }

  ctx.body = result;
});

agentToolsRouter.put('/agents/tools/:tool_id', async (ctx: Context) => {
  const projectIds = await checkToolsAccess(ctx, 'agents:UpdateAgentTool');
  if (projectIds === null) return;

  const { name, type, description, parameters, execute, mcp, actions } = (ctx
    .request.body ?? {}) as Record<string, unknown>;

  let parsedParameters: object | null | undefined;
  let parsedExecute: object | null | undefined;
  let parsedMcp: object | null | undefined;
  try {
    parsedParameters = coerceToJsonObject(parameters);
    parsedExecute = coerceToJsonObject(execute);
    parsedMcp = coerceToJsonObject(mcp);
  } catch {
    ctx.status = 400;
    ctx.body = { error: 'parameters, execute, and mcp must be JSON objects' };
    return;
  }

  const result = await updateAgentTool({
    projectIds,
    id: ctx.params.tool_id,
    name: parseStringOrUndefined(name),
    type: parseStringOrUndefined(type),
    description: parseNullableString(description),
    parameters: parsedParameters,
    execute: parsedExecute,
    mcp: parsedMcp,
    actions: parseNullableArray(actions),
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent tool not found' };
    return;
  }

  ctx.body = result;
});

agentToolsRouter.delete('/agents/tools/:tool_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:DeleteAgentTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await deleteAgentTool({
    projectIds,
    id: ctx.params.tool_id,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Agent tool not found' };
    return;
  }

  ctx.status = 204;
});
