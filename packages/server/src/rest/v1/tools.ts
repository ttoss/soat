import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  callTool,
  createTool,
  deleteTool,
  getTool,
  listTools,
  updateTool,
} from 'src/lib/tools';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  assertGuardrailDetachAllowed,
  parseGuardrailIds,
} from './guardrailAttach';
import {
  parsePagination,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
} from './helpers';

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
    presetParameters: coerceToJsonObject(body.preset_parameters) ?? undefined,
    pipeline: coerceToJsonObject(body.pipeline) ?? undefined,
    outputMapping: coerceToJsonObject(body.output_mapping) ?? undefined,
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
): Promise<number> => {
  requireAuth(ctx);
  // `requireProjectAccess`, not the read helper: a caller permitted in zero
  // projects cannot create here, and an empty scope must say so with a `403`
  // rather than falling through to "project_id is required" (#1029).
  const projectIds = await requireProjectAccess({
    ctx,
    projectPublicId,
    action,
    resourceType: 'tool',
  });
  const targetProjectId = projectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  if (!targetProjectId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }
  return targetProjectId!;
};

/**
 * @openapi
 * /api/v1/tools:
 *   post:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools/post'
 */
toolsRouter.post('/tools', async (ctx: Context) => {
  const body = ctx.request.body as Record<string, unknown>;
  const { name, type, description, actions } = body;
  const deniedActions = body.denied_actions;
  const contextKeys = body.context_keys;
  const projectPublicId = body.project_id as string | undefined;

  if (!name || typeof name !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'name is required');
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
    throw new DomainError('VALIDATION_FAILED', TOOL_JSON_FIELDS_ERROR);
  }

  const result = await createTool({
    projectId: Number(targetProjectId),
    name,
    type: parseStringOrUndefined(type),
    description: parseStringOrUndefined(description),
    actions: Array.isArray(actions) ? (actions as string[]) : undefined,
    deniedActions: Array.isArray(deniedActions)
      ? (deniedActions as string[])
      : undefined,
    contextKeys: parseNullableArray(contextKeys),
    guardrailIds: parseGuardrailIds(body.guardrail_ids),
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
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'tools:ListTools',
    resourceType: 'tool',
  });

  ctx.body = await listTools({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/tools/{tool_id}:
 *   get:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools~1{tool_id}/get'
 */
toolsRouter.get('/tools/:tool_id', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'tools:GetTool',
    resourceType: 'tool',
  });

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
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'tools:UpdateTool',
    resourceType: 'tool',
  });
  const body = ctx.request.body as Record<string, unknown>;
  const {
    name,
    type,
    description,
    parameters,
    execute,
    mcp,
    actions,
    pipeline,
  } = body;
  const deniedActions = body.denied_actions;
  const contextKeys = body.context_keys;
  const presetParameters = body.preset_parameters;
  const outputMapping = body.output_mapping;

  const nextGuardrailIds = parseGuardrailIds(body.guardrail_ids);

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
    throw new DomainError('VALIDATION_FAILED', TOOL_JSON_FIELDS_ERROR);
  }

  // Detaching a guardrail requires guardrails:DetachGuardrail on top of the
  // tools:UpdateTool that reached this handler. Load the current attachments to
  // detect a removal before applying the update.
  if (nextGuardrailIds !== undefined) {
    const current = await getTool({ projectIds, id: ctx.params.tool_id });
    await assertGuardrailDetachAllowed({
      ctx,
      projectPublicId: current.project_id,
      current: current.guardrail_ids,
      next: nextGuardrailIds,
    });
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
    deniedActions: parseNullableArray(deniedActions),
    contextKeys: parseNullableArray(contextKeys),
    presetParameters: parsedPresetParameters,
    pipeline: parsedPipeline,
    outputMapping: parsedOutputMapping,
    guardrailIds: nextGuardrailIds,
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
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'tools:DeleteTool',
    resourceType: 'tool',
  });

  // The success response is `204 No Content`, so the audit middleware has no
  // body to backfill the project/SRN from — hand it the resolved resource
  // before the delete runs (see `setAuditResourceHint`).
  const tool = await getTool({ projectIds, id: ctx.params.tool_id });
  setAuditResourceHint(ctx, {
    projectPublicId: tool.project_id,
    resourceSrn: buildSrn({
      projectPublicId: tool.project_id,
      resourceType: 'tool',
      resourceId: tool.id,
    }),
    resourcePublicId: tool.id,
  });

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
 * contract. Object/array results are left as-is: a tool result is caller-owned
 * data, so its keys are passed through untouched.
 *
 * `undefined` is serialized as `null` rather than passed through: a `undefined`
 * Koa body sets no status, so the response would keep the framework default of
 * `404` and report a call that *succeeded* as a missing resource. A tool whose
 * action legitimately returns nothing — a SOAT action answering `204`, now that
 * those resolve instead of failing to parse (#888) — reaches here.
 */
const setCallToolResponseBody = (ctx: Context, result: unknown): void => {
  if (result !== null && result !== undefined && typeof result === 'object') {
    ctx.body = result;
  } else {
    ctx.type = 'application/json';
    ctx.body = JSON.stringify(result ?? null);
  }
};

/**
 * @openapi
 * /api/v1/tools/{tool_id}/call:
 *   post:
 *     $ref: 'openapi/v1/tools.yaml#/paths/~1api~1v1~1tools~1{tool_id}~1call/post'
 */
toolsRouter.post('/tools/:tool_id/call', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'tools:CallTool',
    resourceType: 'tool',
  });

  const { action, input } = ctx.request.body as {
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
