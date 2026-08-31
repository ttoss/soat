import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { deleteAgent } from 'src/lib/agentDelete';
import { toStoredKnowledgeConfig } from 'src/lib/agentKnowledge';
import { createAgent, getAgent, listAgents, updateAgent } from 'src/lib/agents';
import { parseWireToolBindings } from 'src/lib/agentToolBindings';
import { buildSrn } from 'src/lib/iam';
import { setAuditResourceHint } from 'src/middleware/audit';

import { agentGenerationRouter } from './agentGeneration';
import { agentVersionsRouter } from './agentVersions';
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

export const agentsRouter = new Router<Context>();

// ── Agents CRUD ──────────────────────────────────────────────────────────

type CreateAgentBody = {
  ai_provider_id?: unknown;
  model_route_id?: unknown;
  name?: unknown;
  instructions?: unknown;
  model?: unknown;
  tool_bindings?: unknown;
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
  trace_content_mode?: unknown;
  on_approval_expiry?: unknown;
  project_id?: string;
  /** Write-only tag for the version this write archives; never stored on the agent. */
  version_label?: unknown;
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

const parseUpdateAgentBody = (body: Record<string, unknown>) => {
  return {
    aiProviderId: parseNullableString(body.ai_provider_id),
    modelRouteId: parseNullableString(body.model_route_id),
    name: parseNullableString(body.name),
    instructions: parseNullableString(body.instructions),
    model: parseNullableString(body.model),
    toolBindings: parseWireToolBindings(body.tool_bindings),
    maxSteps: parseOptional<number | null>(body.max_steps),
    toolChoice: parseOptional<string | object | null>(body.tool_choice),
    stopConditions: parseOptional<object[] | null>(body.stop_conditions),
    activeToolIds: parseOptional<string[] | null>(body.active_tool_ids),
    stepRules: parseOptional<object[] | null>(body.step_rules),
    boundaryPolicy: parseOptional<object | null>(body.boundary_policy),
    temperature: parseOptional<number | null>(body.temperature),
    knowledgeConfig:
      body.knowledge_config === undefined
        ? undefined
        : toStoredKnowledgeConfig(body.knowledge_config),
    outputSchema: parseOptional<object | null>(body.output_schema),
    maxContextMessages: parseOptional<number | null>(body.max_context_messages),
    singleSessionPerActor:
      typeof body.single_session_per_actor === 'boolean'
        ? body.single_session_per_actor
        : undefined,
    guardrailIds: parseGuardrailIds(body.guardrail_ids),
    // Forwarded unvalidated so the lib rejects a bad value (or a loosening of
    // a zero-retention project) with a 400 rather than dropping it silently.
    traceContentMode: parseOptional<string | null>(body.trace_content_mode),
    // Forwarded unvalidated for the same reason as `trace_content_mode`: the
    // lib owns the vocabulary, so a bad value is a 400 rather than a silent
    // fallback to the terminating default.
    onApprovalExpiry: parseOptional<string | null>(body.on_approval_expiry),
    // Annotates the archived version, not the agent — deliberately absent from
    // the config snapshot, so labelling a change is not itself a change.
    versionLabel: parseNullableString(body.version_label),
  };
};

const resolveAgentProjectId = async (
  ctx: Context,
  projectPublicId: string | undefined
): Promise<number | 403 | 400> => {
  const authUser = ctx.authUser!;
  const projectIds = await requireProjectAccess({
    ctx,
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

/** The create-time model binding: exactly one of these reaches `createAgent`. */
const parseModelBinding = (body: CreateAgentBody) => {
  return {
    aiProviderId:
      typeof body.ai_provider_id === 'string' ? body.ai_provider_id : undefined,
    modelRouteId:
      typeof body.model_route_id === 'string' ? body.model_route_id : undefined,
  };
};

const buildCreateAgentArgs = (args: {
  projectId: number;
  body: CreateAgentBody;
  createdByUserId?: number;
}): Parameters<typeof createAgent>[0] => {
  const { projectId, body, createdByUserId } = args;
  return {
    projectId,
    createdByUserId,
    versionLabel: parseNullableString(body.version_label),
    ...parseModelBinding(body),
    name: typeof body.name === 'string' ? body.name : undefined,
    instructions:
      typeof body.instructions === 'string' ? body.instructions : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    toolBindings: parseWireToolBindings(body.tool_bindings),
    maxSteps: parseNumber(body.max_steps),
    toolChoice: body.tool_choice as string | object | undefined,
    // Forwarded whatever its shape, like the update path already does: the lib
    // owns the vocabulary, so a non-array (or a malformed condition) is a 400
    // instead of being dropped here and stored as "no conditions".
    stopConditions: parseOptional<object[]>(body.stop_conditions),
    activeToolIds: Array.isArray(body.active_tool_ids)
      ? body.active_tool_ids
      : undefined,
    stepRules: Array.isArray(body.step_rules) ? body.step_rules : undefined,
    boundaryPolicy: body.boundary_policy as object | undefined,
    temperature: parseNumber(body.temperature),
    knowledgeConfig: toStoredKnowledgeConfig(body.knowledge_config) as
      object | undefined,
    outputSchema: body.output_schema as object | undefined,
    maxContextMessages: parseNumber(body.max_context_messages),
    singleSessionPerActor:
      typeof body.single_session_per_actor === 'boolean'
        ? body.single_session_per_actor
        : undefined,
    guardrailIds: parseGuardrailIds(body.guardrail_ids),
    traceContentMode: body.trace_content_mode as string | null | undefined,
    onApprovalExpiry: body.on_approval_expiry as string | null | undefined,
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

  const parsed = parseUpdateAgentBody(body);

  if (parsed.guardrailIds !== undefined) {
    const current = await getAgent({ projectIds, id: ctx.params.agent_id });
    await assertGuardrailDetachAllowed({
      ctx,
      projectPublicId: current.project_id,
      current: current.guardrail_ids,
      next: parsed.guardrailIds,
    });
  }

  return updateAgent({
    projectIds,
    id: ctx.params.agent_id,
    ...parsed,
    // Attributes the archived version to whoever made the change.
    createdByUserId: ctx.authUser?.id,
  });
};

agentsRouter.post('/agents', async (ctx: Context) => {
  requireAuth(ctx);

  const reqBody = ctx.request.body as CreateAgentBody;

  const targetProjectId = await resolveAgentProjectId(ctx, reqBody.project_id);

  if (targetProjectId === 403) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  /* istanbul ignore next */
  if (targetProjectId === 400) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }

  const result = await createAgent(
    buildCreateAgentArgs({
      projectId: targetProjectId,
      body: reqBody,
      createdByUserId: ctx.authUser.id,
    })
  );

  ctx.status = 201;
  ctx.body = result;
});

agentsRouter.get('/agents', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'agents:ListAgents',
    resourceType: 'agent',
  });

  ctx.body = await listAgents({ projectIds, ...parsePagination(ctx) });
});

agentsRouter.get('/agents/:agent_id', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'agents:GetAgent',
    resourceType: 'agent',
  });

  const result = await getAgent({
    projectIds,
    id: ctx.params.agent_id,
  });

  ctx.body = result;
});

agentsRouter.put('/agents/:agent_id', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'agents:UpdateAgent',
    resourceType: 'agent',
  });

  ctx.body = await runAgentUpdate({ ctx, projectIds });
});

agentsRouter.patch('/agents/:agent_id', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'agents:UpdateAgent',
    resourceType: 'agent',
  });

  ctx.body = await runAgentUpdate({ ctx, projectIds });
});

agentsRouter.delete('/agents/:agent_id', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'agents:DeleteAgent',
    resourceType: 'agent',
  });

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

// ── Versions and staged rollout ──────────────────────────────────────────

agentsRouter.use(agentVersionsRouter.routes());
agentsRouter.use(agentVersionsRouter.allowedMethods());
