import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';
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
import { withUnavailableToolsNote } from './agentToolUnavailable';
import {
  getGenerationPendingState,
  notAwaitingToolOutputs,
} from './generationPendingState';
import { getGeneration, updateGenerationRecord } from './generations';
import { agentReferences } from './resourceReferences';
import { saveTrace } from './traces';

// ── Agent Resolver ────────────────────────────────────────────────────────

/**
 * The agent a turn runs, as configured for the project it runs in.
 *
 * `runProjectId` names that project: the agent is its own, or another
 * project's reached through an accepted share. A shared agent runs on its
 * owner's configuration, with the run project in `project` and its own in
 * `ownerProject`; its own guardrails name guardrails in its owner's project,
 * so they do not apply.
 */
export const resolveAgentForGeneration = async (args: {
  agentId: string;
  projectIds?: number[];
  runProjectId?: number;
}): Promise<TypedAgent | null> => {
  const reference =
    args.runProjectId === undefined
      ? null
      : await agentReferences.find({
          id: args.agentId,
          projectId: args.runProjectId,
          reach: 'shares',
        });
  if (args.runProjectId !== undefined && !reference) return null;
  const agent = await agents.findByPublicId({
    id: args.agentId,
    projectIds: reference ? [reference.projectId] : args.projectIds,
  });
  if (!agent || !reference || agent.projectId === args.runProjectId) {
    return agent as unknown as TypedAgent | null;
  }

  const runProject = await db.Project.findByPk(args.runProjectId);
  if (!runProject) return null;
  return {
    ...agent.get(),
    project: {
      id: runProject.id,
      publicId: runProject.publicId,
      guardrailIds: runProject.guardrailIds,
      maxChainGenerations: runProject.maxChainGenerations,
      requirePricedModel: runProject.requirePricedModel,
    },
    ownerProject: {
      id: agent.projectId,
      publicId: agent.project.publicId,
    },
    guardrailIds: null,
  };
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

/**
 * A stop-here depth-guard result when the recursion budget is spent, or null
 * to proceed.
 */
export const buildDepthGuardIfExhausted = async (args: {
  agentId: string;
  projectIds?: number[];
  runProjectId?: number;
  maxDepth: number;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<GenerationResult | null> => {
  if (args.maxDepth > 0) return null;

  const depthAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
    runProjectId: args.runProjectId,
  });
  if (!depthAgent) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );
  }
  return buildDepthGuardResult({
    traceId: args.traceId,
    projectId: depthAgent.project.id as number,
    projectPublicId: depthAgent.project.publicId,
    agentId: args.agentId,
    generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  });
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

  const { tools, unavailableToolNames } = await resolveAgentToolSurface({
    agentId: args.agentId,
    generationId: args.generationId,
    projectIds: args.projectIds,
    typedAgent: args.typedAgent,
    authHeader: args.authHeader,
    toolContext: args.pendingState.toolContext ?? undefined,
    remainingDepth: args.pendingState.remainingDepth ?? undefined,
    // Trusted: `pendingState.toolContext` is persisted after the chokepoint
    // pin, so a caller-forged value never reaches it.
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
    // Re-derived for this segment rather than trusted from the persisted
    // history: a binding that resolved when the turn started can be gone by the
    // time it resumes, and the resumed segment would otherwise run without it
    // silently. An unchanged note is not repeated.
    messages: withUnavailableToolsNote({
      messages: args.pendingState.messages,
      unavailableToolNames,
    }),
    steps: args.pendingState.steps ?? [],
    resolvedModel: resolution.model,
    aiProviderId: args.typedAgent.aiProvider?.publicId ?? null,
    agentConfig: toAgentConfig(args.typedAgent),
    resolvedTools: tools,
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

  if (!gen || gen.agent_id !== args.agentId) return undefined;

  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });
  if (!typedAgent) return undefined;
  // After the scope check, so a refusal never confirms a generation the caller
  // cannot reach. The stored state outlives the pause it was written for.
  if (gen.status !== 'requires_action') {
    throw notAwaitingToolOutputs(args.generationId);
  }
  if (!pendingState) return undefined;

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
