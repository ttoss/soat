import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { agents } from './agentAccessor';
import { type AgentAuthority, resolveAgentAuthority } from './agentAuthority';
import {
  type ClientToolResult,
  type GenerationResult,
  ownerProjectId,
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
import {
  createGenerationProvenance,
  trackGenerationProvenance,
} from './generationProvenance';
import { createGenerationRecord, generations } from './generations';
import { settleGeneration } from './generationSettle';
import type { ReplayedWindow } from './replayRefusal';
import { agentReferences } from './resourceReferences';
import { saveTrace } from './traces';
import { type TraceStepTarget, writeTraceSteps } from './traceStepStore';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:generation');

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
 * platform working as intended. The refused turn gets a row that settles at
 * once, so its handle resolves like any other generation's. The row joins no
 * chain: a member would count against the budget and conclude the chain.
 */
const buildGuardResult = async (args: {
  kind: GuardKind;
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  generationId: string;
  authority: WorkAuthority | null;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<GenerationResult> => {
  const message = GUARD_MESSAGES[args.kind];
  const recorded = await createGenerationRecord({
    publicId: args.generationId,
    projectId: args.projectId,
    agentId: args.agentId,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    authority: args.authority,
    actsAsAgent: null,
    clock: null,
  }).then(
    () => {
      return true;
    },
    (error: unknown) => {
      log('buildGuardResult: record failed %s %o', args.generationId, error);
      return false;
    }
  );
  const saveGuardTrace = () => {
    return saveTrace({
      traceId: args.traceId,
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
      agentId: args.agentId,
      generationId: args.generationId,
      steps: [{ type: args.kind, message }],
      parentTraceId: args.parentTraceId ?? null,
      rootTraceId: args.rootTraceId ?? null,
    });
  };
  if (recorded) {
    await settleGeneration({
      generationId: args.generationId,
      fence: 'lease',
      outcome: {
        status: 'completed',
        stopReason: args.kind,
        assistantContent: message,
      },
      effects: () => {
        return [saveGuardTrace()];
      },
    });
  } else {
    await saveGuardTrace().catch(
      /* istanbul ignore next -- a broken trace write is logged by saveTrace */ () => {}
    );
  }
  return {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: { model: '', content: message, finishReason: 'stop' },
  };
};

export const buildDepthGuardResult = (
  args: Omit<Parameters<typeof buildGuardResult>[0], 'kind'>
): Promise<GenerationResult> => {
  return buildGuardResult({ ...args, kind: 'depth_guard' });
};

/**
 * The continuation chain spent its generation budget. Unlike the depth guard
 * this is usually reached with nobody awaiting the result — the resumption that
 * asked for the turn is a background sweep — so the trace is the record.
 */
export const buildChainGuardResult = (
  args: Omit<Parameters<typeof buildGuardResult>[0], 'kind'>
): Promise<GenerationResult> => {
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
  authority: WorkAuthority | null;
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
    authority: args.authority,
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
  turnMessageCount?: number;
  stepCount?: number;
  /** A pause written before steps were stored as they end. */
  steps?: unknown[];
  parentTraceId: string | null;
  rootTraceId: string | null;
  toolContext: Record<string, string> | null;
  remainingDepth: number | null;
  /** Absent on a pause that kept no window. */
  replayed?: ReplayedWindow | null;
};

/**
 * The steps the paused turn spent. A pause that carries its steps never wrote
 * them to the trace; they are written before the turn resumes past them.
 */
const restoredStepCount = async (args: {
  target: TraceStepTarget;
  pendingState: PendingStateDb;
}): Promise<number> => {
  const { steps } = args.pendingState;
  if (!Array.isArray(steps)) return args.pendingState.stepCount ?? 0;
  await writeTraceSteps({ target: args.target, firstIndex: 0, steps });
  return steps.length;
};

const buildPendingFromState = async (args: {
  generationId: string;
  agentId: string;
  projectIds?: number[];
  authority: WorkAuthority | null;
  typedAgent: TypedAgent;
  agentAuthority: AgentAuthority;
  traceId: string;
  pendingState: PendingStateDb;
  /** The counts the generation row stores, which the pause wrote. */
  stored: { untrustedToolResults: number; knowledgeResults: number };
}): Promise<PendingGeneration | undefined> => {
  // A route-only agent has no pinned provider, so the resumption path must
  // resolve the route too — otherwise this least-traveled consumer is the one
  // place routing silently breaks.
  const resolution = await resolveAgentModel(args.typedAgent);
  if (resolution.failure) return undefined;

  const provenance = createGenerationProvenance({
    untrusted_tool_results: args.stored.untrustedToolResults,
    knowledge_results: args.stored.knowledgeResults,
  });
  trackGenerationProvenance({ generationId: args.generationId, provenance });

  const { tools, unavailableToolNames } = await resolveAgentToolSurface({
    agentId: args.agentId,
    generationId: args.generationId,
    projectIds: args.projectIds,
    typedAgent: args.typedAgent,
    agentAuthority: args.agentAuthority,
    authority: args.authority,
    toolContext: args.pendingState.toolContext ?? undefined,
    remainingDepth: args.pendingState.remainingDepth ?? undefined,
    // Trusted: `pendingState.toolContext` is persisted after the chokepoint
    // pin, so a caller-forged value never reaches it.
    sessionId: args.pendingState.toolContext?.sessionId ?? null,
    provenance,
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
    turnMessageCount: args.pendingState.turnMessageCount,
    stepCount: await restoredStepCount({
      target: {
        traceId: args.traceId,
        generationId: args.generationId,
        projectId: args.typedAgent.project.id as number,
        projectPublicId: args.typedAgent.project.publicId,
        agentId: args.agentId,
      },
      pendingState: args.pendingState,
    }),
    resolvedModel: resolution.model,
    aiProviderId: args.typedAgent.aiProvider?.publicId ?? null,
    agentConfig: toAgentConfig(args.typedAgent),
    resolvedTools: tools,
    toolsAuthority: args.authority,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
    provenance,
    replayed: args.pendingState.replayed ?? null,
  };
};

export const recoverPendingFromDb = async (args: {
  generationId: string;
  agentId: string;
  projectIds?: number[];
  authority: WorkAuthority | null;
}): Promise<PendingGeneration | undefined> => {
  const [gen, storedState] = await Promise.all([
    generations.findByPublicId({
      id: args.generationId,
      projectIds: args.projectIds,
    }),
    getGenerationPendingState({ publicId: args.generationId }),
  ]);
  const pendingState = (storedState ?? undefined) as PendingStateDb | undefined;

  if (!gen?.trace || gen.agentPublicId !== args.agentId) return undefined;

  // The turn resumes in the project it ran in, which a shared agent's is not.
  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    runProjectId: gen.projectId,
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
    authority: args.authority,
    typedAgent,
    agentAuthority: await resolveAgentAuthority({
      agentId: args.agentId,
      runAs: typedAgent.runAs,
      policyIds: typedAgent.policyIds,
      actorId: pendingState.toolContext?.actor_id,
      projectPublicId: typedAgent.project.publicId,
      ownerProjectId: ownerProjectId(typedAgent),
    }),
    traceId: gen.trace.publicId,
    pendingState,
    stored: gen,
  });
};
