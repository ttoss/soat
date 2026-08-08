/* eslint-disable max-lines */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { denormalizeKnowledgeConfig } from './agentKnowledge';
import {
  type AgentToolBinding,
  deriveLegacyToolFields,
  readAgentToolBindings,
  resolveBindingsForCreate,
  resolveBindingsForUpdate,
  toWireToolBinding,
  type WireAgentToolBinding,
} from './agentToolBindings';
import {
  type AgentConfigSnapshot,
  agentVersionStore,
  buildAgentConfigSnapshot,
} from './agentVersionSnapshot';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { deleteStorageObjects } from './fileStorage';
import { assertGuardrailsExist } from './guardrails';
import {
  assertModelBindingResolvable,
  resolveModelRouteDbId,
  validateModelRouteExclusivity,
} from './modelRoutes';
import { validateOutputSchema } from './outputSchema';
import { paginatedList, type PaginatedResult } from './pagination';
import { type ActiveRelease, parseActiveRelease } from './releaseAssignment';
import { type InlineToolDefinition } from './tools';
import {
  invalidateTraceContentModeCache,
  validateAgentTraceContentMode,
} from './traceContentPolicy';

const log = createDebug('soat:agents');

export type { AgentToolBinding, InlineToolDefinition };

// Re-export symbols that callers expect from this module.
export {
  createGeneration,
  type GenerationResult,
  submitToolOutputs,
} from './agentGeneration';
export { resolveUrlPathParams } from './agentToolResolver';

// ── Mapped Types ─────────────────────────────────────────────────────────

export type MappedAgent = {
  id: string;
  project_id: string;
  /** Null when the agent resolves its model through `model_route_id` instead. */
  ai_provider_id: string | null;
  /** Null when the agent pins a provider through `ai_provider_id` instead. */
  model_route_id: string | null;
  name: string | null;
  instructions: string | null;
  model: string | null;
  tool_bindings: WireAgentToolBinding[] | null;
  tool_ids: string[] | null;
  tools: InlineToolDefinition[] | null;
  max_steps: number | null;
  tool_choice: string | object | null;
  stop_conditions: object[] | null;
  active_tool_ids: string[] | null;
  step_rules: object[] | null;
  boundary_policy: object | null;
  temperature: number | null;
  knowledge_config: object | null;
  output_schema: object | null;
  max_context_messages: number | null;
  single_session_per_actor: boolean;
  trace_content_mode: string | null;
  guardrail_ids: string[] | null;
  /** Current config version; starts at 1 and bumps on every config change. */
  version: number;
  /** Staged rollout in progress, or null when all traffic serves this config. */
  active_release: ActiveRelease | null;
  created_at: Date;
  updated_at: Date;
};

// ── Map Functions ────────────────────────────────────────────────────────

const getAgentIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.AiProvider, as: 'aiProvider' },
    { model: db.ModelRoute, as: 'modelRoute' },
  ];
};

const mapAgent = (
  agent: InstanceType<typeof db.Agent> & {
    project: InstanceType<typeof db.Project>;
    aiProvider: InstanceType<typeof db.AiProvider> | null;
    modelRoute: InstanceType<typeof db.ModelRoute> | null;
  }
): MappedAgent => {
  // Canonical bindings (legacy rows normalize lazily); the deprecated
  // `toolIds`/`tools` views are derived from them for the response echo.
  const toolBindings = readAgentToolBindings(agent);
  const legacyViews = deriveLegacyToolFields(toolBindings);

  return {
    id: agent.publicId,
    project_id: agent.project.publicId,
    ai_provider_id: agent.aiProvider?.publicId ?? null,
    model_route_id: agent.modelRoute?.publicId ?? null,
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    tool_bindings: toolBindings ? toolBindings.map(toWireToolBinding) : null,
    tool_ids: legacyViews.toolIds,
    tools: legacyViews.tools,
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
  toolIds?: string[] | null;
  tools?: InlineToolDefinition[] | null;
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

/**
 * The bound tool ids a generation may actually resolve, after applying the
 * agent's `active_tool_ids` restriction (`modules/agents.md` — Active Tools).
 *
 * Shared by the generation and recovery paths so a resumed run is restricted
 * exactly like the run it resumes.
 *
 * Two deliberate fail-open cases, both about not disarming a live agent for a
 * value that cannot express real intent:
 *
 * - **absent / empty** — an empty active set would leave the agent with no
 *   tools at all, which is never a deliberate configuration, and agents stored
 *   `[]` while this field was inert (#811), so honouring it literally would
 *   silently strip their tools on upgrade.
 * - **not an array** — the column is untyped JSON, so a legacy or hand-written
 *   row can hold anything.
 *
 * Inline (ephemeral) tool definitions carry no id, so they can never be named
 * here and are always left active; they are authored on the agent itself
 * alongside this field rather than referenced from the project.
 */
export const narrowToActiveTools = (args: {
  toolIds: string[];
  activeToolIds: unknown;
}): string[] => {
  if (!Array.isArray(args.activeToolIds)) return args.toolIds;
  const allowed = new Set(
    args.activeToolIds.filter((id): id is string => {
      return typeof id === 'string';
    })
  );
  if (allowed.size === 0) return args.toolIds;
  return args.toolIds.filter((id) => {
    return allowed.has(id);
  });
};

/**
 * Rejects an `active_tool_ids` entry that names no tool in the project, so a
 * typo surfaces as a `400` on write instead of silently narrowing the agent's
 * tool surface at generation time. Mirrors `assertGuardrailsExist` — both
 * fields are declared references (`x-soat-ref`) and only one of them used to
 * be checked (#811). A null/empty list is a no-op: it clears the restriction.
 */
const assertActiveToolsExist = async (args: {
  activeToolIds: string[] | null | undefined;
  projectId: number;
}): Promise<void> => {
  const ids = args.activeToolIds ?? [];
  if (ids.length === 0) return;

  const found = await db.Tool.findAll({
    where: { publicId: ids, projectId: args.projectId },
    attributes: ['publicId'],
  });
  const foundSet = new Set(
    found.map((tool) => {
      return tool.publicId;
    })
  );
  const missing = ids.filter((id) => {
    return !foundSet.has(id);
  });
  if (missing.length > 0) {
    throw new DomainError(
      'TOOL_NOT_FOUND',
      `Tool(s) not found in the project: ${missing.join(', ')}.`,
      { missing }
    );
  }
};

/**
 * Resolves persisted tool ids to their names, for `step_rules[].active_tool_ids`
 * (`modules/agents.md` — Step Rules, #809). The AI SDK's `activeTools` option is
 * keyed by tool **name**, while the persisted rule holds tool **ids** — this is
 * the id→name map `buildPrepareStep` needs to translate one into the other.
 *
 * Unlike `assertActiveToolsExist`, this runs at generation time rather than on
 * write: an id naming no tool in the project (typo, wrong project, a tool
 * deleted after the rule was written) is silently dropped from the map instead
 * of rejected, so a step rule with mixed valid/stale ids still restricts to
 * the ids that resolve rather than failing the whole generation.
 */
export const resolveToolIdsToNames = async (args: {
  toolIds: string[];
  projectId: number;
}): Promise<Record<string, string>> => {
  if (args.toolIds.length === 0) return {};

  const found = await db.Tool.findAll({
    where: { publicId: args.toolIds, projectId: args.projectId },
    attributes: ['publicId', 'name'],
  });

  const map: Record<string, string> = {};
  for (const foundTool of found) {
    map[foundTool.publicId] = foundTool.name;
  }
  return map;
};

/**
 * Every declared cross-resource reference on an agent write, checked together.
 * Both are no-ops for an absent list, so create and update share one call.
 */
/**
 * Enforces the project's zero-retention floor: an agent may tighten to `none`
 * but never loosen a `none` project back to `full` (#838). Checked on every
 * write path (create and update alike), so a project-wide mandate cannot be
 * escaped by an agent created afterwards.
 */
const assertTraceContentModeAllowed = async (args: {
  traceContentMode: string | null | undefined;
  projectId: number;
}): Promise<void> => {
  if (args.traceContentMode === undefined) return;

  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['id', 'traceContentMode'],
  });

  const message = validateAgentTraceContentMode({
    projectMode: project?.traceContentMode ?? 'none',
    agentMode: args.traceContentMode,
  });

  if (message) throw new DomainError('VALIDATION_FAILED', message);
};

const assertAgentReferencesExist = async (args: {
  guardrailIds: string[] | null | undefined;
  activeToolIds: string[] | null | undefined;
  traceContentMode?: string | null;
  projectId: number;
}): Promise<void> => {
  await assertGuardrailsExist({
    guardrailIds: args.guardrailIds,
    projectId: args.projectId,
  });
  await assertActiveToolsExist({
    activeToolIds: args.activeToolIds,
    projectId: args.projectId,
  });
  await assertTraceContentModeAllowed({
    traceContentMode: args.traceContentMode,
    projectId: args.projectId,
  });
};

// `toolBindings`/`toolIds`/`tools` are handled by the binding-normalization
// path, not copied verbatim.
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

const resolveAiProviderDbId = async (
  publicId: string
): Promise<number | null> => {
  const aiProvider = await db.AiProvider.findOne({ where: { publicId } });
  return aiProvider ? (aiProvider as unknown as { id: number }).id : null;
};

/**
 * An agent resolves its completion model through **at most one** of a pinned
 * provider or a model route; binding neither inherits the project's
 * `default_model_route_id`. The pure rule lives in `modelRoutes` (shared with
 * the formation module) and this asserts it as the standard `VALIDATION_FAILED`
 * (400); the second guard is the database fact that a project default actually
 * exists to inherit.
 */
const assertModelBinding = async (args: {
  projectId: number;
  modelRouteId: unknown;
  aiProviderId: unknown;
  model: unknown;
}): Promise<void> => {
  const error = validateModelRouteExclusivity(args);
  if (error) throw new DomainError('VALIDATION_FAILED', error);

  await assertModelBindingResolvable({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
    modelRouteId: args.modelRouteId,
    resourceLabel: 'agent',
  });
};

const requireAiProviderDbId = async (publicId: string): Promise<number> => {
  const dbId = await resolveAiProviderDbId(publicId);
  if (!dbId) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${publicId}' not found.`
    );
  }
  return dbId;
};

/**
 * Resolves the create-time model binding: at most one of a pinned provider or a
 * model route, both stored as internal ids. Both null means the agent inherits
 * its project's default route.
 */
const resolveCreateModelBinding = async (args: {
  projectId: number;
  aiProviderId?: string;
  modelRouteId?: string;
  model?: string;
}): Promise<{ aiProviderId: number | null; modelRouteId: number | null }> => {
  await assertModelBinding({
    projectId: args.projectId,
    modelRouteId: args.modelRouteId,
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  return {
    aiProviderId: args.aiProviderId
      ? await requireAiProviderDbId(args.aiProviderId)
      : null,
    modelRouteId: args.modelRouteId
      ? await resolveModelRouteDbId({
          modelRouteId: args.modelRouteId,
          projectId: args.projectId,
        })
      : null,
  };
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
    toolIds?: string[];
    tools?: InlineToolDefinition[];
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
    // Canonical storage only — the legacy columns stay null on new rows.
    toolBindings,
    toolIds: null,
    tools: null,
    projectId: args.projectId,
    aiProviderId,
    modelRouteId,
  });

  const created = await db.Agent.findOne({
    where: { id: (agent as unknown as { id: number }).id },
    include: getAgentIncludes(),
  });

  const mapped = mapAgent(created as unknown as Parameters<typeof mapAgent>[0]);

  // Version 1 is archived on create, so an agent has recoverable history from
  // the moment it exists rather than from its first edit.
  await agentVersionStore.writeVersion({
    resourceDbId: (agent as unknown as { id: number }).id,
    version: 1,
    config: buildAgentConfigSnapshot(mapped),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
  });

  emitEvent({
    type: 'agents.created',
    projectId: args.projectId,
    projectPublicId: (created as unknown as { project: { publicId: string } })
      .project.publicId,
    resourceType: 'agent',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
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
      return mapAgent(a as unknown as Parameters<typeof mapAgent>[0]);
    },
  });
};

export const getAgent = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedAgent> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where, include: getAgentIncludes() });
  if (!agent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );

  return mapAgent(agent as unknown as Parameters<typeof mapAgent>[0]);
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
  agent: InstanceType<typeof db.Agent>;
  args: AgentUpdateFields;
  updates: Record<string, unknown>;
}): Promise<void> => {
  const { agent, args: fields, updates } = args;
  const projectId = (agent as unknown as { projectId: number }).projectId;

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
  agent: InstanceType<typeof db.Agent>;
  before: AgentConfigSnapshot;
  after: AgentConfigSnapshot;
  authorship: AgentVersionAuthorship;
}): Promise<void> => {
  await agentVersionStore.archiveConfigChange({
    resourceDbId: (args.agent as unknown as { id: number }).id,
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

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  // Loaded with its joins so the pre-write config can be snapshotted through
  // the same mapper that serializes the response — the diff is then between two
  // wire-shaped configs, never between a model instance and a response body.
  const agent = await db.Agent.findOne({ where, include: getAgentIncludes() });
  if (!agent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );

  const beforeConfig = buildAgentConfigSnapshot(
    mapAgent(agent as unknown as Parameters<typeof mapAgent>[0])
  );

  // No-ops for an undefined list (attachments/restriction left untouched).
  await assertAgentReferencesExist({
    guardrailIds: args.guardrailIds,
    activeToolIds: args.activeToolIds,
    traceContentMode: args.traceContentMode,
    projectId: (agent as unknown as { projectId: number }).projectId,
  });

  const bindingsUpdate = await resolveBindingsForUpdate({
    projectId: (agent as unknown as { projectId: number }).projectId,
    current: readAgentToolBindings(
      agent as unknown as Parameters<typeof readAgentToolBindings>[0]
    ),
    toolBindings: args.toolBindings,
    toolIds: args.toolIds,
    tools: args.tools,
  });

  const updates = buildAgentUpdates(args);
  if (bindingsUpdate !== undefined) {
    updates.toolBindings = bindingsUpdate;
    updates.toolIds = null;
    updates.tools = null;
  }

  await applyModelBindingUpdates({ agent, args, updates });

  await agent.update(updates);

  // Tightening an agent to `none` must stop content writes on its next
  // generation, not once the 30s cache entry expires.
  invalidateTraceContentModeCache({
    agentDbId: (agent as unknown as { id: number }).id,
    projectDbId: (agent as unknown as { projectId: number }).projectId,
    agentPublicId: args.id,
  });

  const updated = (await db.Agent.findOne({
    where: { id: (agent as unknown as { id: number }).id },
    include: getAgentIncludes(),
  })) as InstanceType<typeof db.Agent>;

  await archiveConfigChange({
    agent: updated,
    before: beforeConfig,
    after: buildAgentConfigSnapshot(
      mapAgent(updated as unknown as Parameters<typeof mapAgent>[0])
    ),
    authorship: args,
  });

  // Mapped after the archive so the response carries the bumped version.
  const mapped = mapAgent(updated as unknown as Parameters<typeof mapAgent>[0]);

  emitEvent({
    type: 'agents.updated',
    projectId: (agent as unknown as { projectId: number }).projectId,
    projectPublicId: (updated as unknown as { project: { publicId: string } })
      .project.publicId,
    resourceType: 'agent',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
};

const findDependentIds = async (args: {
  agentId: number;
}): Promise<{
  generationIds: number[];
  traceIds: number[];
  fileIds: number[];
}> => {
  const [generationRows, traceRows] = await Promise.all([
    db.Generation.findAll({
      where: { agentId: args.agentId },
      attributes: ['id'],
    }),
    db.Trace.findAll({
      where: { agentId: args.agentId },
      attributes: ['id', 'fileId'],
    }),
  ]);

  return {
    generationIds: generationRows.map((row) => {
      return (row as unknown as { id: number }).id;
    }),
    traceIds: traceRows.map((row) => {
      return (row as unknown as { id: number }).id;
    }),
    fileIds: traceRows
      .map((row) => {
        return (row as unknown as { fileId: number | null }).fileId;
      })
      .filter((fileId): fileId is number => {
        return fileId !== null;
      }),
  };
};

// Deletes an agent's generations/traces along with it. Cross-references from
// OTHER agents' rows into the ones being deleted (self-referencing FKs on
// Generation.initiatorGenerationId and Trace.parentTraceId/rootTraceId) are
// nulled out first, since those FKs are RESTRICT. Traces own a File holding
// their serialized steps (see `saveTrace`); those File rows are destroyed
// alongside the traces, and their storage objects are cleaned up once the
// transaction commits (see #835 — the row must be gone before the object is,
// otherwise a concurrent read could reference bytes mid-delete).
const forceDeleteAgentWithDependents = async (args: {
  agent: InstanceType<typeof db.Agent>;
  agentId: number;
}): Promise<void> => {
  const { generationIds, traceIds, fileIds } = await findDependentIds({
    agentId: args.agentId,
  });

  const files =
    fileIds.length > 0
      ? await db.File.findAll({
          where: { id: fileIds },
          attributes: ['storagePath', 'storageType'],
        })
      : [];

  await db.sequelize.transaction(async (transaction) => {
    if (generationIds.length > 0) {
      await db.Generation.update(
        { initiatorGenerationId: null },
        { where: { initiatorGenerationId: generationIds }, transaction }
      );
    }
    if (traceIds.length > 0) {
      await db.Trace.update(
        { parentTraceId: null },
        { where: { parentTraceId: traceIds }, transaction }
      );
      await db.Trace.update(
        { rootTraceId: null },
        { where: { rootTraceId: traceIds }, transaction }
      );
    }

    await db.Generation.destroy({
      where: { agentId: args.agentId },
      transaction,
    });
    await db.Trace.destroy({ where: { agentId: args.agentId }, transaction });
    if (fileIds.length > 0) {
      await db.File.destroy({ where: { id: fileIds }, transaction });
    }
    // Archived configs are owned by the agent; remove them before the parent so
    // no orphan version rows are left behind.
    await agentVersionStore.deleteVersions({
      resourceDbId: args.agentId,
      transaction,
    });
    await args.agent.destroy({ transaction });
  });

  await deleteStorageObjects(
    files.map((file) => {
      return { storagePath: file.storagePath, storageType: file.storageType };
    })
  );
};

export const deleteAgent = async (args: {
  projectIds?: number[];
  id: string;
  force?: boolean;
}): Promise<void> => {
  log('deleteAgent: id=%s force=%s', args.id, Boolean(args.force));

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  if (!agent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );

  const agentId = (agent as unknown as { id: number }).id;

  const [generationCount, traceCount] = await Promise.all([
    db.Generation.count({ where: { agentId } }),
    db.Trace.count({ where: { agentId } }),
  ]);

  if (generationCount > 0 || traceCount > 0) {
    if (!args.force) {
      throw new DomainError(
        'AGENT_HAS_DEPENDENTS',
        `Agent '${args.id}' has dependent generations or traces and cannot be deleted.`,
        { generationCount, traceCount }
      );
    }

    log(
      'deleteAgent: force-cascading id=%s generations=%d traces=%d',
      args.id,
      generationCount,
      traceCount
    );

    await forceDeleteAgentWithDependents({ agent, agentId });
  } else {
    // Archived configs are owned by the agent, so they go first (the FK is
    // RESTRICT); Actor.agentId is cleared automatically by the DB via
    // onDelete: 'SET NULL' on its own FK.
    await db.AgentVersion.destroy({ where: { agentId } });
    await agent.destroy();
  }

  const agentProjectId = (agent as unknown as { projectId: number }).projectId;

  resolveProjectPublicId({ projectId: agentProjectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'agents.deleted',
        projectId: agentProjectId,
        projectPublicId,
        resourceType: 'agent',
        resourceId: args.id,
        data: { id: args.id },
        timestamp: new Date().toISOString(),
      });
    }
  );
};
