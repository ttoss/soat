import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import type { AgentToolBinding, InlineToolDefinition } from 'src/lib/agents';
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
} from 'src/lib/agents';
import { buildSrn } from 'src/lib/iam';
import { setAuditResourceHint } from 'src/middleware/audit';

import { agentGenerationRouter } from './agentGeneration';
import {
  assertGuardrailDetachAllowed,
  parseGuardrailIds,
} from './guardrailAttach';
import { parsePagination } from './helpers';
import { coerceToJsonObject } from './tools';

export const agentsRouter = new Router<Context>();

// ── Agents CRUD ──────────────────────────────────────────────────────────

type CreateAgentBody = {
  ai_provider_id?: unknown;
  name?: unknown;
  instructions?: unknown;
  model?: unknown;
  tool_bindings?: unknown;
  tool_ids?: unknown;
  tools?: unknown;
  max_steps?: unknown;
  tool_choice?: unknown;
  stop_conditions?: unknown;
  active_tool_ids?: unknown;
  step_rules?: unknown;
  boundary_policy?: unknown;
  temperature?: unknown;
  knowledge_config?: unknown;
  output_schema?: unknown;
  max_context_messages?: unknown;
  single_session_per_actor?: unknown;
  guardrail_ids?: unknown;
  project_id?: string;
};

/**
 * Parses one inline tool definition from a request body (`CreateAgentRequest`
 * / `UpdateAgentRequest`'s `tools` array). Returns `null` when the value is
 * not an object or is missing a string `name`, so the caller can return 400.
 */
const parseInlineToolDefinition = (
  value: unknown
): InlineToolDefinition | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

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
    outputMapping,
  } = value as Record<string, unknown>;

  if (!name || typeof name !== 'string') return null;

  try {
    return {
      name,
      type: typeof type === 'string' ? type : undefined,
      description: typeof description === 'string' ? description : undefined,
      parameters: coerceToJsonObject(parameters) as object | undefined,
      execute: coerceToJsonObject(execute) as object | undefined,
      mcp: coerceToJsonObject(mcp) as object | undefined,
      actions: Array.isArray(actions) ? (actions as string[]) : undefined,
      presetParameters: coerceToJsonObject(presetParameters) as
        object | undefined,
      pipeline: coerceToJsonObject(pipeline) as object | undefined,
      outputMapping: coerceToJsonObject(outputMapping) as object | undefined,
    };
  } catch {
    return null;
  }
};

const INLINE_TOOLS_ERROR =
  'tools must be an array of tool definition objects with a name';

/**
 * Parses the `tools` array of inline tool definitions. Returns `undefined`
 * when absent (leave as-is), `null` when explicitly cleared, `'invalid'` when
 * malformed (not an array, or an entry without a string `name`), or the
 * parsed definitions otherwise.
 */
const parseInlineTools = (
  value: unknown
): InlineToolDefinition[] | null | undefined | 'invalid' => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) return 'invalid';

  const parsed: InlineToolDefinition[] = [];
  for (const item of value) {
    const def = parseInlineToolDefinition(item);
    if (!def) return 'invalid';
    parsed.push(def);
  }
  return parsed;
};

const parseNullableString = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
};

const parseOptional = <T>(v: unknown): T | undefined => {
  return v !== undefined ? (v as T) : undefined;
};

const parseNumber = (v: unknown): number | undefined => {
  return typeof v === 'number' ? v : undefined;
};

const parseUpdateAgentBody = (
  body: Record<string, unknown>,
  tools: InlineToolDefinition[] | null | undefined
) => {
  return {
    aiProviderId:
      typeof body.ai_provider_id === 'string' ? body.ai_provider_id : undefined,
    name: parseNullableString(body.name),
    instructions: parseNullableString(body.instructions),
    model: parseNullableString(body.model),
    toolBindings: parseOptional<AgentToolBinding[] | null>(body.tool_bindings),
    toolIds: parseOptional<string[] | null>(body.tool_ids),
    tools,
    maxSteps: parseOptional<number | null>(body.max_steps),
    toolChoice: parseOptional<string | object | null>(body.tool_choice),
    stopConditions: parseOptional<object[] | null>(body.stop_conditions),
    activeToolIds: parseOptional<string[] | null>(body.active_tool_ids),
    stepRules: parseOptional<object[] | null>(body.step_rules),
    boundaryPolicy: parseOptional<object | null>(body.boundary_policy),
    temperature: parseOptional<number | null>(body.temperature),
    knowledgeConfig: parseOptional<object | null>(body.knowledge_config),
    outputSchema: parseOptional<object | null>(body.output_schema),
    maxContextMessages: parseOptional<number | null>(body.max_context_messages),
    singleSessionPerActor:
      typeof body.single_session_per_actor === 'boolean'
        ? body.single_session_per_actor
        : undefined,
    guardrailIds: parseGuardrailIds(body.guardrail_ids),
  };
};

const resolveAgentProjectId = async (
  authUser: NonNullable<Context['authUser']>,
  projectPublicId: string | undefined
): Promise<number | 403 | 400> => {
  const projectIds = await authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:CreateAgent',
    resourceType: 'agent',
  });
  if (projectIds === null) return 403;
  let targetProjectId = projectIds?.[0];
  /* istanbul ignore next */
  if (!targetProjectId && authUser.apiKeyProjectId) {
    const project = await db.Project.findOne({
      where: { id: authUser.apiKeyProjectId },
    });
    if (project) targetProjectId = project.id as number;
  }
  /* istanbul ignore next */
  if (!targetProjectId) return 400;
  return targetProjectId;
};

const buildCreateAgentArgs = (
  projectId: number,
  body: CreateAgentBody,
  tools: InlineToolDefinition[] | undefined
): Parameters<typeof createAgent>[0] => {
  return {
    projectId,
    aiProviderId: body.ai_provider_id as string,
    name: typeof body.name === 'string' ? body.name : undefined,
    instructions:
      typeof body.instructions === 'string' ? body.instructions : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    toolBindings: parseOptional<AgentToolBinding[] | null>(body.tool_bindings),
    toolIds: Array.isArray(body.tool_ids) ? body.tool_ids : undefined,
    tools,
    maxSteps: parseNumber(body.max_steps),
    toolChoice: body.tool_choice as string | object | undefined,
    stopConditions: Array.isArray(body.stop_conditions)
      ? body.stop_conditions
      : undefined,
    activeToolIds: Array.isArray(body.active_tool_ids)
      ? body.active_tool_ids
      : undefined,
    stepRules: Array.isArray(body.step_rules) ? body.step_rules : undefined,
    boundaryPolicy: body.boundary_policy as object | undefined,
    temperature: parseNumber(body.temperature),
    knowledgeConfig: body.knowledge_config as object | undefined,
    outputSchema: body.output_schema as object | undefined,
    maxContextMessages: parseNumber(body.max_context_messages),
    singleSessionPerActor:
      typeof body.single_session_per_actor === 'boolean'
        ? body.single_session_per_actor
        : undefined,
    guardrailIds: parseGuardrailIds(body.guardrail_ids),
  };
};

// Shared by the PUT and PATCH handlers: parses the body, enforces the
// guardrail detach permission when the update drops an attached id, and applies
// the update.
const runAgentUpdate = async (args: {
  ctx: Context;
  projectIds: number[] | undefined;
}) => {
  const { ctx, projectIds } = args;
  const body = ctx.request.body as Record<string, unknown>;

  const tools = parseInlineTools(body.tools);
  if (tools === 'invalid') {
    throw new DomainError('VALIDATION_FAILED', INLINE_TOOLS_ERROR);
  }

  const parsed = parseUpdateAgentBody(body, tools);

  if (parsed.guardrailIds !== undefined) {
    const current = await getAgent({ projectIds, id: ctx.params.agent_id });
    await assertGuardrailDetachAllowed({
      ctx,
      projectPublicId: current.project_id,
      current: current.guardrail_ids,
      next: parsed.guardrailIds,
    });
  }

  return updateAgent({ projectIds, id: ctx.params.agent_id, ...parsed });
};

agentsRouter.post('/agents', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const reqBody = ctx.request.body as CreateAgentBody;

  if (!reqBody.ai_provider_id || typeof reqBody.ai_provider_id !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'aiProviderId is required' };
    return;
  }

  const tools = parseInlineTools(reqBody.tools);
  if (tools === 'invalid') {
    throw new DomainError('VALIDATION_FAILED', INLINE_TOOLS_ERROR);
  }

  const targetProjectId = await resolveAgentProjectId(
    ctx.authUser,
    reqBody.project_id
  );

  if (targetProjectId === 403) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  /* istanbul ignore next */
  if (targetProjectId === 400) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const result = await createAgent(
    buildCreateAgentArgs(targetProjectId, reqBody, tools ?? undefined)
  );

  ctx.status = 201;
  ctx.body = result;
});

agentsRouter.get('/agents', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:ListAgents',
    resourceType: 'agent',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listAgents({ projectIds, ...parsePagination(ctx) });
});

agentsRouter.get('/agents/:agent_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetAgent',
    resourceType: 'agent',
  });

  /* istanbul ignore next */
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getAgent({
    projectIds,
    id: ctx.params.agent_id,
  });

  ctx.body = result;
});

agentsRouter.put('/agents/:agent_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateAgent',
    resourceType: 'agent',
  });

  /* istanbul ignore next */
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await runAgentUpdate({ ctx, projectIds });
});

agentsRouter.patch('/agents/:agent_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:UpdateAgent',
    resourceType: 'agent',
  });

  /* istanbul ignore next */
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await runAgentUpdate({ ctx, projectIds });
});

agentsRouter.delete('/agents/:agent_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:DeleteAgent',
    resourceType: 'agent',
  });

  /* istanbul ignore next */
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  // The success response is `204 No Content`, so the audit middleware has no
  // body to backfill the project/SRN from — hand it the resolved resource
  // before the delete runs (see `setAuditResourceHint`).
  const agent = await getAgent({ projectIds, id: ctx.params.agent_id });
  setAuditResourceHint(ctx, {
    projectPublicId: agent.project_id,
    resourceSrn: buildSrn({
      projectPublicId: agent.project_id,
      resourceType: 'agent',
      resourceId: agent.id,
    }),
    resourcePublicId: agent.id,
  });

  const force = ctx.query.force === 'true';

  await deleteAgent({
    projectIds,
    id: ctx.params.agent_id,
    force,
  });

  ctx.status = 204;
});

// ── Generation ───────────────────────────────────────────────────────────

agentsRouter.use(agentGenerationRouter.routes());
agentsRouter.use(agentGenerationRouter.allowedMethods());
