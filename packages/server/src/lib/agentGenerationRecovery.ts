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
  // A route-only agent has no pinned provider, so the resumption path has to
  // resolve the route too — a client-tool continuation is the least-traveled
  // consumer and would otherwise be the one place routing silently broke. An
  // agent whose binding no longer resolves makes the pending generation
  // unrecoverable, which the caller reports as a plain "not found".
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
    // Trusted read: `pendingState.toolContext` is persisted AFTER the
    // chokepoint pin in buildGenerationContext (#850), so a `sessionId` key
    // here is always server-stamped — a caller-forged value never reaches the
    // persisted state.
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
