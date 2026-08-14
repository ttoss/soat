import { db } from '../db';
import {
  type AgentRow,
  agents,
  getAgentIncludes,
  type MappedAgent,
} from './agentAccessor';
import { denormalizeKnowledgeConfig } from './agentKnowledge';
import {
  type AgentToolBinding,
  readAgentToolBindings,
  resolveBindingsForCreate,
  resolveBindingsForUpdate,
  toWireToolBinding,
} from './agentToolBindings';
import {
  type AgentConfigSnapshot,
  agentVersionStore,
  buildAgentConfigSnapshot,
} from './agentVersionSnapshot';
import {
  assertAgentReferencesExist,
  assertModelBinding,
  requireAiProviderDbId,
  resolveCreateModelBinding,
} from './agentWriteValidation';
import { emitResourceEvent } from './eventBus';
import { resolveModelRouteDbId } from './modelRoutes';
import { validateOutputSchema } from './outputSchema';
import { paginatedList, type PaginatedResult } from './pagination';
import { parseActiveRelease } from './releaseAssignment';
import { type InlineToolDefinition } from './tools';
import { invalidateTraceContentModeCache } from './traceContentPolicy';

export type { AgentToolBinding, InlineToolDefinition, MappedAgent };

// ── Mapped Types ─────────────────────────────────────────────────────────

// ── Map Functions ────────────────────────────────────────────────────────

const mapAgent = (agent: AgentRow): MappedAgent => {
  const toolBindings = readAgentToolBindings(agent);

  return {
    id: agent.publicId,
    project_id: agent.project.publicId,
    ai_provider_id: agent.aiProvider?.publicId ?? null,
    model_route_id: agent.modelRoute?.publicId ?? null,
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    tool_bindings: toolBindings ? toolBindings.map(toWireToolBinding) : null,
    max_steps: agent.maxSteps,
    tool_choice: agent.toolChoice,
    stop_conditions: agent.stopConditions,
    active_tool_ids: agent.activeToolIds,
    step_rules: agent.stepRules,
    boundary_policy: agent.boundaryPolicy,
    temperature: agent.temperature,
    knowledge_config: denormalizeKnowledgeConfig(agent.knowledgeConfig) ?? null,
    output_schema: agent.outputSchema,
    max_context_messages: agent.maxContextMessages,
    single_session_per_actor: agent.singleSessionPerActor,
    guardrail_ids: agent.guardrailIds,
    trace_content_mode: agent.traceContentMode,
    version: agent.version,
    // Normalized rather than echoed raw, so the release the API reports is
    // exactly the one the generation path will act on.
    active_release: parseActiveRelease(agent.activeRelease),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
};

// ── Agent CRUD Helpers ────────────────────────────────────────────────────

type AgentUpdateFields = {
  aiProviderId?: string | null;
  modelRouteId?: string | null;
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  toolBindings?: AgentToolBinding[] | null;
  maxSteps?: number | null;
  toolChoice?: string | object | null;
  stopConditions?: object[] | null;
  activeToolIds?: string[] | null;
  stepRules?: object[] | null;
  boundaryPolicy?: object | null;
  temperature?: number | null;
  knowledgeConfig?: object | null;
  outputSchema?: object | null;
  maxContextMessages?: number | null;
  singleSessionPerActor?: boolean;
  guardrailIds?: string[] | null;
  traceContentMode?: string | null;
};

/**
 * Who caused a config write, and an optional tag for the version it archives.
 * Accepted by both write paths so history records an author regardless of
 * whether the change arrived through REST or a formation apply.
 */
type AgentVersionAuthorship = {
  createdByUserId?: number | null;
  versionLabel?: string | null;
};

// `toolBindings` is handled by the binding-normalization path, not copied
// verbatim.
const AGENT_SCALAR_FIELDS = [
  'name',
  'instructions',
  'model',
  'maxSteps',
  'toolChoice',
  'stopConditions',
  'activeToolIds',
  'stepRules',
  'boundaryPolicy',
  'temperature',
  'knowledgeConfig',
  'outputSchema',
  'maxContextMessages',
  'singleSessionPerActor',
  'guardrailIds',
  'traceContentMode',
] as const;

const buildAgentUpdates = (
  args: AgentUpdateFields
): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  for (const field of AGENT_SCALAR_FIELDS) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  return updates;
};

// ── Agent CRUD ───────────────────────────────────────────────────────────

/** Column defaults applied to a new agent, before the caller's own fields. */
const AGENT_CREATE_DEFAULTS = {
  name: null,
  instructions: null,
  model: null,
  maxSteps: 20,
  toolChoice: null,
  stopConditions: null,
  activeToolIds: null,
  stepRules: null,
  boundaryPolicy: null,
  temperature: null,
  maxContextMessages: null,
};

export const createAgent = async (
  args: {
    projectId: number;
    aiProviderId?: string;
    modelRouteId?: string;
    name?: string;
    instructions?: string;
    model?: string;
    toolBindings?: AgentToolBinding[] | null;
    maxSteps?: number;
    toolChoice?: string | object;
    stopConditions?: object[];
    activeToolIds?: string[];
    stepRules?: object[];
    boundaryPolicy?: object;
    temperature?: number;
    knowledgeConfig?: object;
    outputSchema?: object;
    maxContextMessages?: number;
    singleSessionPerActor?: boolean;
    guardrailIds?: string[] | null;
    traceContentMode?: string | null;
  } & AgentVersionAuthorship
): Promise<MappedAgent> => {
  validateOutputSchema(args.outputSchema);

  const { aiProviderId, modelRouteId } = await resolveCreateModelBinding(args);

  await assertAgentReferencesExist({
    guardrailIds: args.guardrailIds,
    activeToolIds: args.activeToolIds,
    traceContentMode: args.traceContentMode,
    projectId: args.projectId,
  });

  const toolBindings = await resolveBindingsForCreate(args);

  const agent = await db.Agent.create({
    ...AGENT_CREATE_DEFAULTS,
    ...buildAgentUpdates(args),
    toolBindings,
    projectId: args.projectId,
    aiProviderId,
    modelRouteId,
  });

  const created = await agents.reload(agent);

  const mapped = mapAgent(created);

  // Version 1 is archived on create, so an agent has recoverable history from
  // the moment it exists rather than from its first edit.
  await agentVersionStore.writeVersion({
    resourceDbId: created.id as number,
    version: 1,
    config: buildAgentConfigSnapshot(mapped),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
  });

  emitResourceEvent({
    type: 'agents.created',
    projectId: args.projectId,
    projectPublicId: created.project.publicId,
    resourceType: 'agent',
    resourceId: mapped.id,
    data: mapped,
  });

  return mapped;
};

export const listAgents = async (args: {
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedAgent>> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Agent.findAndCountAll({
        where,
        include: getAgentIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (a) => {
      return mapAgent(a as AgentRow);
    },
  });
};

export const getAgent = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedAgent> => {
  return mapAgent(await agents.getByPublicId(args));
};

/** The value a field will hold after the update: incoming, else stored. */
const effectiveValue = (incoming: unknown, stored: unknown): unknown => {
  return incoming !== undefined ? incoming : stored;
};

/**
 * Applies the `ai_provider_id` / `model_route_id` half of an update. The
 * exclusivity invariant is checked against the **effective post-write state**
 * (the incoming value where provided, the stored one otherwise), so a partial
 * update that touches neither field can never trip it — and switching an agent
 * to a route requires clearing the pin in the same request.
 */
const applyModelBindingUpdates = async (args: {
  agent: AgentRow;
  args: AgentUpdateFields;
  updates: Record<string, unknown>;
}): Promise<void> => {
  const { agent, args: fields, updates } = args;
  const projectId = agent.projectId;

  const touchesBinding =
    fields.aiProviderId !== undefined || fields.modelRouteId !== undefined;
  if (!touchesBinding && fields.model === undefined) return;

  await assertModelBinding({
    projectId,
    aiProviderId: effectiveValue(fields.aiProviderId, agent.aiProviderId),
    modelRouteId: effectiveValue(fields.modelRouteId, agent.modelRouteId),
    model: effectiveValue(fields.model, agent.model),
  });

  if (fields.aiProviderId !== undefined) {
    updates.aiProviderId = fields.aiProviderId
      ? await requireAiProviderDbId(fields.aiProviderId)
      : null;
  }

  if (fields.modelRouteId !== undefined) {
    updates.modelRouteId = fields.modelRouteId
      ? await resolveModelRouteDbId({
          modelRouteId: fields.modelRouteId,
          projectId,
        })
      : null;
  }
};

/**
 * Archives the post-write config as a new version, but only when the write
 * actually changed it. The change detection and the archive write live in the
 * shared engine; what stays here is bumping the counter on the agent row, which
 * the engine deliberately never touches.
 */
const archiveConfigChange = async (args: {
  agent: AgentRow;
  before: AgentConfigSnapshot;
  after: AgentConfigSnapshot;
  authorship: AgentVersionAuthorship;
}): Promise<void> => {
  await agentVersionStore.archiveConfigChange({
    resourceDbId: args.agent.id as number,
    currentVersion: args.agent.version,
    before: args.before,
    after: args.after,
    label: args.authorship.versionLabel,
    createdByUserId: args.authorship.createdByUserId,
    bumpVersion: async (nextVersion) => {
      await args.agent.update({ version: nextVersion });
    },
  });
};

export const updateAgent = async (
  args: {
    projectIds?: number[];
    id: string;
  } & AgentUpdateFields &
    AgentVersionAuthorship
): Promise<MappedAgent> => {
  validateOutputSchema(args.outputSchema);

  // Loaded with its joins so the pre-write config can be snapshotted through
  // the same mapper that serializes the response — the diff is then between two
  // wire-shaped configs, never between a model instance and a response body.
  const agent = await agents.getByPublicId(args);

  const beforeConfig = buildAgentConfigSnapshot(mapAgent(agent));

  // No-ops for an undefined list (attachments/restriction left untouched).
  await assertAgentReferencesExist({
    guardrailIds: args.guardrailIds,
    activeToolIds: args.activeToolIds,
    traceContentMode: args.traceContentMode,
    projectId: agent.projectId,
  });

  const bindingsUpdate = await resolveBindingsForUpdate({
    projectId: agent.projectId,
    toolBindings: args.toolBindings,
  });

  const updates = buildAgentUpdates(args);
  if (bindingsUpdate !== undefined) {
    updates.toolBindings = bindingsUpdate;
  }

  await applyModelBindingUpdates({ agent, args, updates });

  await agent.update(updates);

  // Tightening an agent to `none` must stop content writes on its next
  // generation, not once the 30s cache entry expires.
  invalidateTraceContentModeCache({
    agentDbId: agent.id as number,
    projectDbId: agent.projectId,
    agentPublicId: args.id,
  });

  const updated = await agents.reload(agent);

  await archiveConfigChange({
    agent: updated,
    before: beforeConfig,
    after: buildAgentConfigSnapshot(mapAgent(updated)),
    authorship: args,
  });

  // Mapped after the archive so the response carries the bumped version.
  const mapped = mapAgent(updated);

  emitResourceEvent({
    type: 'agents.updated',
    projectId: agent.projectId,
    projectPublicId: updated.project.publicId,
    resourceType: 'agent',
    resourceId: mapped.id,
    data: mapped,
  });

  return mapped;
};
