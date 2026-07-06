import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  callTool,
  createTool,
  deleteTool,
  getTool,
  listTools,
  updateTool,
} from 'src/lib/tools';

export const toolsRouter = new Router<Context>();

const parseStringOrUndefined = (v: unknown): string | undefined => {
  return typeof v === 'string' ? v : undefined;
};

/**
 * Coerces an input value to a plain JSON object, null, or undefined.
 * Accepts already-parsed objects or JSON-encoded strings. Throws a TypeError
 * when the value is present but cannot be coerced to a plain object, so the
 * caller can return a 400 response.
 */
export const coerceToJsonObject = (v: unknown): object | null | undefined => {
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

const TOOL_JSON_FIELDS_ERROR =
  'parameters, execute, mcp, preset_parameters, pipeline, and output_mapping must be JSON objects';

/**
 * Coerces the JSON-object config fields shared by create/update. Throws
 * `TypeError` on a malformed field so the caller can return 400.
 */
const coerceToolJsonFields = (body: Record<string, unknown>) => {
  return {
    parameters: coerceToJsonObject(body.parameters) ?? undefined,
    execute: coerceToJsonObject(body.execute) ?? undefined,
    mcp: coerceToJsonObject(body.mcp) ?? undefined,
    presetParameters: coerceToJsonObject(body.presetParameters) ?? undefined,
    pipeline: coerceToJsonObject(body.pipeline) ?? undefined,
    outputMapping: coerceToJsonObject(body.outputMapping) ?? undefined,
  };
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

/**
 * @openapi
 * /api/v1/tools:
 *   post:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools/post'
 */
toolsRouter.post('/tools', async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const { name, type, description, actions } = body;
  const projectPublicId = body.projectId as string | undefined;
  const discussionId = body.discussionId as string | undefined;

  if (!name || typeof name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const targetProjectId = await resolveToolProjectId(
    ctx,
    'tools:CreateTool',
    projectPublicId
  );
  if (!targetProjectId) return;

  let jsonFields: ReturnType<typeof coerceToolJsonFields>;
  try {
    jsonFields = coerceToolJsonFields(body);
  } catch {
    ctx.status = 400;
    ctx.body = { error: TOOL_JSON_FIELDS_ERROR };
    return;
  }

  const result = await createTool({
    projectId: Number(targetProjectId),
    name,
    type: parseStringOrUndefined(type),
    description: parseStringOrUndefined(description),
    actions: Array.isArray(actions) ? (actions as string[]) : undefined,
    discussionId,
    ...jsonFields,
  });

  ctx.status = 201;
  ctx.body = result;
});

/**
 * @openapi
 * /api/v1/tools:
 *   get:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools/get'
 */
toolsRouter.get('/tools', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'tools:ListTools',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listTools({ projectIds });
});

/**
 * @openapi
 * /api/v1/tools/{tool_id}:
 *   get:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools~1{tool_id}/get'
 */
toolsRouter.get('/tools/:tool_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'tools:GetTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getTool({
    projectIds,
    id: ctx.params.tool_id,
  });

  ctx.body = result;
});

/**
 * @openapi
 * /api/v1/tools/{tool_id}:
 *   patch:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools~1{tool_id}/patch'
 */
toolsRouter.patch('/tools/:tool_id', async (ctx: Context) => {
  const projectIds = await checkToolsAccess(ctx, 'tools:UpdateTool');
  if (projectIds === null) return;

  const {
    name,
    type,
    description,
    parameters,
    execute,
    mcp,
    actions,
    presetParameters,
    pipeline,
    discussionId,
    outputMapping,
  } = (ctx.request.body ?? {}) as Record<string, unknown>;

  let parsedParameters: object | null | undefined;
  let parsedExecute: object | null | undefined;
  let parsedMcp: object | null | undefined;
  let parsedPresetParameters: object | null | undefined;
  let parsedPipeline: object | null | undefined;
  let parsedOutputMapping: object | null | undefined;
  try {
    parsedParameters = coerceToJsonObject(parameters);
    parsedExecute = coerceToJsonObject(execute);
    parsedMcp = coerceToJsonObject(mcp);
    parsedPresetParameters = coerceToJsonObject(presetParameters);
    parsedPipeline = coerceToJsonObject(pipeline);
    parsedOutputMapping = coerceToJsonObject(outputMapping);
  } catch {
    ctx.status = 400;
    ctx.body = { error: TOOL_JSON_FIELDS_ERROR };
    return;
  }

  const result = await updateTool({
    projectIds,
    id: ctx.params.tool_id,
    name: parseStringOrUndefined(name),
    type: parseStringOrUndefined(type),
    description: parseNullableString(description),
    parameters: parsedParameters,
    execute: parsedExecute,
    mcp: parsedMcp,
    actions: parseNullableArray(actions),
    presetParameters: parsedPresetParameters,
    pipeline: parsedPipeline,
    discussionId: parseNullableString(discussionId),
    outputMapping: parsedOutputMapping,
  });

  ctx.body = result;
});

/**
 * @openapi
 * /api/v1/tools/{tool_id}:
 *   delete:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools~1{tool_id}/delete'
 */
toolsRouter.delete('/tools/:tool_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'tools:DeleteTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteTool({
    projectIds,
    id: ctx.params.tool_id,
  });

  ctx.status = 204;
});

/**
 * A tool's `output_mapping` can resolve to a bare scalar (e.g. a string
 * extracted via `{ var: "output.text" }`). Koa infers a `text/plain` content
 * type for raw string/number/boolean bodies, so those are explicitly
 * serialized as JSON to honor the endpoint's declared `application/json`
 * contract. Object/array results are left as-is so the caseTransform
 * middleware can still convert their keys to snake_case.
 */
const setCallToolResponseBody = (ctx: Context, result: unknown): void => {
  if (result !== null && typeof result === 'object') {
    ctx.body = result;
  } else {
    ctx.type = 'application/json';
    ctx.body = JSON.stringify(result);
  }
};

/**
 * @openapi
 * /api/v1/tools/{tool_id}/call:
 *   post:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools~1{tool_id}~1call/post'
 */
toolsRouter.post('/tools/:tool_id/call', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'tools:CallTool',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { action, input } = (ctx.request.body ?? {}) as {
    action?: unknown;
    input?: unknown;
  };

  const parsedInput =
    input !== undefined &&
    input !== null &&
    typeof input === 'object' &&
    !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;

  const authHeader = ctx.request.headers.authorization;

  const result = await callTool({
    projectIds,
    id: ctx.params.tool_id,
    action: typeof action === 'string' ? action : undefined,
    input: parsedInput,
    authHeader,
  });

  setCallToolResponseBody(ctx, result);
});
