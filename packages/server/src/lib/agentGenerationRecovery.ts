import { agents } from './agentAccessor';
import {
  type ClientToolResult,
  type GenerationResult,
  type PendingGeneration,
  toAgentConfig,
  type TypedAgent,
} from './agentGenerationTypes';
import { resolveAgentModel } from './agentModelResolution';
import { resolveAgentToolSurface } from './agentToolSurface';
import { getGenerationPendingState } from './generationPendingState';
import { getGeneration, updateGenerationRecord } from './generations';
import { saveTrace } from './traces';

// ── Agent Resolver ────────────────────────────────────────────────────────

export const resolveAgentForGeneration = async (args: {
  agentId: string;
  projectIds?: number[];
}): Promise<TypedAgent | null> => {
  const agent = await agents.findByPublicId({
    id: args.agentId,
    projectIds: args.projectIds,
  });

  return agent as unknown as TypedAgent | null;
};

// ── Recursion and chain guards ─────────────────────────────────────────────

type GuardKind = 'depth_guard' | 'chain_limit';

const GUARD_MESSAGES: Record<GuardKind, string> = {
  depth_guard: 'Maximum call depth reached',
  chain_limit: 'Continuation chain limit reached',
};

/**
 * A turn refused before the provider is called: the trace records why, and the
 * caller gets a completed result rather than an error, because a refusal is the
 * platform working as intended. No generation row is written — the id never
 * reached `createGenerationRecord`.
 */
const buildGuardResult = (args: {
  kind: GuardKind;
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
    generationId: args.generationId,
    steps: [{ type: args.kind, message: GUARD_MESSAGES[args.kind] }],
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
    stopReason: args.kind,
  }).catch(/* istanbul ignore next -- see saveTrace above */ () => {});
  return {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: {
      model: '',
      content: GUARD_MESSAGES[args.kind],
      finishReason: 'stop',
    },
  };
};

export const buildDepthGuardResult = (
  args: Omit<Parameters<typeof buildGuardResult>[0], 'kind'>
): GenerationResult => {
  return buildGuardResult({ ...args, kind: 'depth_guard' });
};

/**
 * The continuation chain spent its generation budget. Unlike the depth guard
 * this is usually reached with nobody awaiting the result — the resumption that
 * asked for the turn is a background sweep — so the trace is the record.
 */
export const buildChainGuardResult = (
  args: Omit<Parameters<typeof buildGuardResult>[0], 'kind'>
): GenerationResult => {
  return buildGuardResult({ ...args, kind: 'chain_limit' });
};

// ── DB Recovery ───────────────────────────────────────────────────────────

type PendingStateDb = {
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  syntheticToolResults?: ClientToolResult[];
  messages: Array<{ role: string; content: string }>;
  steps?: unknown[];
  parentTraceId: string | null;
  rootTraceId: string | null;
  toolContext: Record<string, string> | null;
  remainingDepth: number | null;
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
  // A route-only agent has no pinned provider, so the resumption path must
  // resolve the route too — otherwise this least-traveled consumer is the one
  // place routing silently breaks.
  const resolution = await resolveAgentModel(args.typedAgent);
  if (resolution.failure) return undefined;

  const resolvedTools = await resolveAgentToolSurface({
    agentId: args.agentId,
    generationId: args.generationId,
    projectIds: args.projectIds,
    typedAgent: args.typedAgent,
    authHeader: args.authHeader,
    toolContext: args.pendingState.toolContext ?? undefined,
    remainingDepth: args.pendingState.remainingDepth ?? undefined,
    // Trusted: `pendingState.toolContext` is persisted after the chokepoint pin
    // (#850), so a caller-forged value never reaches it.
    sessionId: args.pendingState.toolContext?.sessionId ?? null,
  });

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
    resolvedModel: resolution.model,
    aiProviderId: args.typedAgent.aiProvider?.publicId ?? null,
    agentConfig: toAgentConfig(args.typedAgent),
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
  const [gen, storedState] = await Promise.all([
    getGeneration({ publicId: args.generationId }),
    getGenerationPendingState({ publicId: args.generationId }),
  ]);
  const pendingState = (storedState ?? undefined) as PendingStateDb | undefined;

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
