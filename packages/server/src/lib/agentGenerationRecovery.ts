import type { LanguageModel } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import {
  type GenerationResult,
  type PendingGeneration,
  type TypedAgent,
} from './agentGenerationHelpers';
import { buildModel } from './agentModel';
import {
  deriveLegacyToolFields,
  readAgentToolBindings,
} from './agentToolBindings';
import { buildResolverGuardrailContext } from './agentToolGuardrail';
import { resolveAgentTools } from './agentToolResolver';
import { getGeneration, updateGenerationRecord } from './generations';
import { buildRoutedModel, loadModelRouteConfig } from './modelRoutes';
import { saveTrace } from './traces';

// ── Agent Resolver ────────────────────────────────────────────────────────

export const resolveAgentForGeneration = async (args: {
  agentId: string;
  projectIds?: number[];
}): Promise<TypedAgent | null> => {
  const where: Record<string, unknown> = { publicId: args.agentId };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({
    where,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.AiProvider, as: 'aiProvider' },
      { model: db.ModelRoute, as: 'modelRoute' },
    ],
  });

  return agent as unknown as TypedAgent | null;
};

// ── Depth Guard ───────────────────────────────────────────────────────────

export const buildDepthGuardResult = (args: {
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  generationId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): GenerationResult => {
  saveTrace({
    traceId: args.traceId,
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    agentId: args.agentId,
    steps: [{ type: 'depth_guard', message: 'Maximum call depth reached' }],
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  }).catch(
    // Fire-and-forget; forcing a real failure here would require a
    // genuinely broken DB write, and mocking saveTrace to fake one would
    // violate the "never mock what you own" boundary policy.
    /* istanbul ignore next */ () => {}
  );
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'completed',
    completedAt: new Date(),
    stopReason: 'depth_guard',
  }).catch(/* istanbul ignore next -- see saveTrace above */ () => {});
  return {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: {
      model: '',
      content: 'Maximum call depth reached',
      finishReason: 'stop',
    },
  };
};

// ── DB Recovery ───────────────────────────────────────────────────────────

type PendingStateDb = {
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  syntheticToolResults?: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
  }>;
  messages: Array<{ role: string; content: string }>;
  steps?: unknown[];
  parentTraceId: string | null;
  rootTraceId: string | null;
  toolContext: Record<string, string> | null;
  remainingDepth: number | null;
};

// Re-resolves the agent's tool surface for a resumed generation, re-applying
// the guardrail interceptor (the single tool-call gating mechanism). The
// caller's guardrail_context is not persisted across the tool-outputs
// round-trip, so only project/agent/tool scope guardrails apply here (caller
// `context.*` keys fail closed). Extracted so buildPendingFromState stays within
// its complexity budget.
const resolveRecoveryTools = async (args: {
  generationId: string;
  agentId: string;
  projectIds?: number[];
  authHeader?: string;
  typedAgent: TypedAgent;
  pendingState: PendingStateDb;
}) => {
  const projectId = args.typedAgent.project.id as number;
  // Canonical bindings (legacy rows normalize lazily); no branch on presence —
  // resolveAgentTools no-ops on empty input, so this covers "no tools at all".
  const bindings = readAgentToolBindings(args.typedAgent);
  const legacyViews = deriveLegacyToolFields(bindings);
  return resolveAgentTools({
    toolIds: legacyViews.toolIds ?? [],
    tools: legacyViews.tools,
    projectId,
    projectIds: args.projectIds,
    boundaryPolicy: args.typedAgent.boundaryPolicy,
    authHeader: args.authHeader,
    toolContext: args.pendingState.toolContext ?? undefined,
    remainingDepth: args.pendingState.remainingDepth ?? undefined,
    guardrail: await buildResolverGuardrailContext({
      agentId: args.agentId,
      generationId: args.generationId,
      projectId,
      projectPublicId: args.typedAgent.project.publicId,
      projectGuardrailIds: args.typedAgent.project.guardrailIds,
      agentGuardrailIds: args.typedAgent.guardrailIds,
      sessionId: args.pendingState.toolContext?.sessionId ?? null,
      authHeader: args.authHeader,
    }),
    // A resumed generation's tool calls are as autonomous as a fresh one's, so
    // they record on the activity feed under the same identity.
    activity: {
      projectId,
      agentId: args.agentId,
      generationId: args.generationId,
    },
  });
};

/**
 * The `LanguageModel` a resumed generation continues on: the agent's model
 * route (composite, with failover) or its pinned provider. Returns `undefined`
 * when neither resolves, which the caller reports as an unrecoverable pending
 * generation.
 */
const resolveResumptionModel = async (
  typedAgent: TypedAgent
): Promise<LanguageModel | undefined> => {
  if (typedAgent.modelRoute) {
    const route = await loadModelRouteConfig({
      modelRouteId: typedAgent.modelRoute.publicId,
    });
    return buildRoutedModel({ route });
  }

  /* istanbul ignore next -- exclusivity guarantees one of the two is set */
  if (!typedAgent.aiProvider) return undefined;

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedAgent.aiProvider.publicId,
  });
  if (!resolved) return undefined;

  return buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: typedAgent.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });
};

const buildPendingFromState = async (args: {
  generationId: string;
  agentId: string;
  projectIds?: number[];
  authHeader?: string;
  typedAgent: TypedAgent;
  traceId: string;
  pendingState: PendingStateDb;
}): Promise<PendingGeneration | undefined> => {
  // A route-only agent has no pinned provider, so the resumption path has to
  // resolve the route too — a client-tool continuation is the least-traveled
  // consumer and would otherwise be the one place routing silently broke.
  const model = await resolveResumptionModel(args.typedAgent);
  if (!model) return undefined;

  const resolvedTools = await resolveRecoveryTools(args);

  return {
    agentId: args.agentId,
    projectId: args.typedAgent.project.id as number,
    traceId: args.traceId,
    parentTraceId: args.pendingState.parentTraceId,
    rootTraceId: args.pendingState.rootTraceId,
    generationId: args.generationId,
    pendingToolCalls: args.pendingState.pendingToolCalls.map((tc) => {
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      };
    }),
    syntheticToolResults: args.pendingState.syntheticToolResults ?? [],
    messages: args.pendingState.messages,
    steps: args.pendingState.steps ?? [],
    resolvedModel: model,
    agentConfig: {
      instructions: args.typedAgent.instructions,
      maxSteps: (args.typedAgent.maxSteps as number) ?? 20,
      toolChoice: args.typedAgent.toolChoice,
      stopConditions: args.typedAgent.stopConditions,
      activeToolIds: args.typedAgent.activeToolIds as string[] | null,
      stepRules: args.typedAgent.stepRules,
      temperature: args.typedAgent.temperature as number | null,
      outputSchema: args.typedAgent.outputSchema,
    },
    resolvedTools,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
  };
};

export const recoverPendingFromDb = async (args: {
  generationId: string;
  agentId: string;
  projectIds?: number[];
  authHeader?: string;
}): Promise<PendingGeneration | undefined> => {
  const gen = await getGeneration({ publicId: args.generationId });
  const pendingState = gen?.metadata?.pendingState as
    PendingStateDb | undefined;

  if (!gen || !pendingState || gen.agent_id !== args.agentId) {
    return undefined;
  }

  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });
  if (!typedAgent) return undefined;

  return buildPendingFromState({
    generationId: args.generationId,
    agentId: args.agentId,
    projectIds: args.projectIds,
    authHeader: args.authHeader,
    typedAgent,
    traceId: gen.trace_id,
    pendingState,
  });
};
