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
import { assertGuardrailsExist } from './guardrails';
import { validatePolicyActions } from './iam';
import {
  assertModelBindingResolvable,
  resolveModelRouteDbId,
  validateModelRouteExclusivity,
} from './modelRoutes';
import { validateAgentTraceContentMode } from './traceContentPolicy';

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

/**
 * Rejects a `boundary_policy` whose action strings do not name real,
 * enforceable permissions.
 *
 * The rule lives in `validatePolicyActions` (`iam.ts`) and is shared with the
 * formation module (`.claude/rules/modules.md` — Shared Business Rules). Only
 * the formation path used to apply it, so a typo'd boundary written through
 * REST was stored unchecked — and a boundary is where that fails open: a
 * mis-named `Deny` matches nothing, leaving the agent permitted.
 *
 * Structural validation stays with the boundary evaluator at generation time.
 */
export const assertBoundaryPolicyActionsKnown = (
  boundaryPolicy: unknown
): void => {
  if (boundaryPolicy === null || boundaryPolicy === undefined) return;
  if (typeof boundaryPolicy !== 'object' || Array.isArray(boundaryPolicy)) {
    return;
  }

  const { valid, errors } = validatePolicyActions(boundaryPolicy);
  if (!valid) {
    throw new DomainError('VALIDATION_FAILED', errors.join('; '));
  }
};

export const assertAgentReferencesExist = async (args: {
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

export const resolveAiProviderDbId = async (
  publicId: string
): Promise<number | null> => {
  const aiProvider = await db.AiProvider.findOne({ where: { publicId } });
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

export const requireAiProviderDbId = async (
  publicId: string
): Promise<number> => {
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
