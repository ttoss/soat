/**
 * Everything an agent write has to check or resolve before it touches a row:
 * the cross-resource reference guards, the trace-retention floor, and the
 * pinned-provider/model-route binding.
 *
 * Split out of `agents.ts` so the CRUD module is CRUD. The rules themselves are
 * unchanged and still shared with the formation module through `modelRoutes` /
 * `traceContentPolicy` (`.claude/rules/modules.md` — Shared Business Rules).
 */
import { db } from '../db';
import { DomainError } from '../errors';
import { collectStepRuleActiveToolIds } from './agentStepRules';
import {
  type AgentToolBinding,
  readAgentToolBindings,
  splitToolBindings,
} from './agentToolBindings';
import { assertGuardrailsExist } from './guardrails';
import {
  assertModelBindingResolvable,
  resolveModelRouteDbId,
  validateModelRouteExclusivity,
} from './modelRoutes';
import { isPlainObject } from './plainObject';
import { toolReferences } from './resourceReferences';
import { validateAgentTraceContentMode } from './traceContentPolicy';

/**
 * Every declared cross-resource reference on an agent write, checked together.
 * Both are no-ops for an absent list, so create and update share one call.
 */
/**
 * Enforces the project's zero-retention floor: an agent may tighten to `none`
 * but never loosen a `none` project back to `full`. Checked on every
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

/** The stored agent an update merges onto: a field the body omits keeps it. */
type StoredAgentToolConfig = {
  projectId: number;
  toolBindings?: unknown;
  activeToolIds?: unknown;
  stepRules?: unknown;
};

type ActiveToolsWrite = {
  current: StoredAgentToolConfig | undefined;
  toolBindings?: AgentToolBinding[] | null;
  activeToolIds?: unknown;
  stepRules?: unknown;
};

/** The write merged onto the stored agent, or `null` for an update sending none of the three. */
const mergeActiveToolsWrite = (args: ActiveToolsWrite) => {
  const { current } = args;
  if (!current) {
    return { ...args, toolBindings: args.toolBindings ?? null };
  }
  if (
    args.toolBindings === undefined &&
    args.activeToolIds === undefined &&
    args.stepRules === undefined
  ) {
    return null;
  }
  return {
    toolBindings:
      args.toolBindings === undefined
        ? readAgentToolBindings(current)
        : args.toolBindings,
    activeToolIds:
      args.activeToolIds === undefined
        ? current.activeToolIds
        : args.activeToolIds,
    stepRules:
      args.stepRules === undefined ? current.stepRules : args.stepRules,
  };
};

const isBindingList = (value: unknown): value is AgentToolBinding[] | null => {
  return value === null || (Array.isArray(value) && value.every(isPlainObject));
};

/**
 * Generation narrows the bound tool ids to the active ones, so an active id
 * that is not bound would leave the agent with fewer tools than it declares,
 * or none. An update is checked as merged, so removing a binding that is still
 * active is refused.
 */
const assertActiveToolsBound = (args: ActiveToolsWrite): void => {
  const merged = mergeActiveToolsWrite(args);
  // A malformed `tool_bindings` is refused by its own validation, with its own message.
  if (!merged || !isBindingList(merged.toolBindings)) return;

  const bound = new Set(splitToolBindings(merged.toolBindings).toolIds);
  const fields: Array<[string, string[]]> = [
    [
      'active_tool_ids',
      Array.isArray(merged.activeToolIds)
        ? merged.activeToolIds.filter((id): id is string => {
            return typeof id === 'string';
          })
        : [],
    ],
    [
      'step_rules[].active_tool_ids',
      collectStepRuleActiveToolIds(merged.stepRules),
    ],
  ];
  for (const [field, ids] of fields) {
    const unbound = ids.find((id) => {
      return !bound.has(id);
    });
    if (unbound !== undefined) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `${field} entry '${unbound}' is not among the agent's tool_bindings.`
      );
    }
  }
};

export const assertAgentReferencesExist = async (
  args: {
    guardrailIds?: string[] | null;
    toolBindings?: AgentToolBinding[] | null;
    activeToolIds?: string[] | null;
    stepRules?: unknown;
    traceContentMode?: string | null;
  } & ({ projectId: number } | { current: StoredAgentToolConfig })
): Promise<void> => {
  const current = 'current' in args ? args.current : undefined;
  const projectId = 'current' in args ? args.current.projectId : args.projectId;
  await assertGuardrailsExist({ guardrailIds: args.guardrailIds, projectId });
  // A typo surfaces as a `400` on write instead of silently narrowing the
  // agent's tool surface at generation time.
  await toolReferences.requireMany({
    ids: [
      ...(args.activeToolIds ?? []),
      ...collectStepRuleActiveToolIds(args.stepRules),
    ],
    projectId,
    reach: 'shares',
  });
  assertActiveToolsBound({ ...args, current });
  await assertTraceContentModeAllowed({
    traceContentMode: args.traceContentMode,
    projectId,
  });
};

/**
 * The internal id of a provider **in this project**. A pin is where the pinning
 * resource's generations get their credential, so one that crossed the project
 * boundary would have this project's agent generate on another project's
 * secret — and the caller's own reach is not the boundary, since a principal
 * may legitimately hold both projects.
 */
export const resolveAiProviderDbId = async (args: {
  publicId: string;
  projectId: number;
}): Promise<number | null> => {
  const aiProvider = await db.AiProvider.findOne({
    where: { publicId: args.publicId, projectId: args.projectId },
  });
  return aiProvider ? (aiProvider.id as number) : null;
};

/**
 * An agent resolves its completion model through **at most one** of a pinned
 * provider or a model route; binding neither inherits the project's
 * `default_model_route_id`. The pure rule lives in `modelRoutes` (shared with
 * the formation module) and this asserts it as the standard `VALIDATION_FAILED`
 * (400); the second guard is the database fact that a project default actually
 * exists to inherit.
 */
export const assertModelBinding = async (args: {
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

/**
 * The message is the same one an id that exists nowhere gets: a caller who may
 * write here learns nothing about which ids are real in a project they cannot
 * pin from.
 */
export const requireAiProviderDbId = async (args: {
  publicId: string;
  projectId: number;
}): Promise<number> => {
  const dbId = await resolveAiProviderDbId(args);
  if (!dbId) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.publicId}' not found.`
    );
  }
  return dbId;
};

/**
 * Resolves the create-time model binding: at most one of a pinned provider or a
 * model route, both stored as internal ids. Both null means the agent inherits
 * its project's default route.
 */
export const resolveCreateModelBinding = async (args: {
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
      ? await requireAiProviderDbId({
          publicId: args.aiProviderId,
          projectId: args.projectId,
        })
      : null,
    modelRouteId: args.modelRouteId
      ? await resolveModelRouteDbId({
          modelRouteId: args.modelRouteId,
          projectId: args.projectId,
        })
      : null,
  };
};
