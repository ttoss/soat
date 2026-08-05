import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';
import type { AuthUser } from 'src/Context';

import { DomainError } from '../errors';
import {
  buildGenerationContext,
  type GenerationContext,
} from './agentGenerationContext';
import {
  type GenerationResult,
  pendingGenerations,
  runStreamGeneration,
} from './agentGenerationHelpers';
import {
  buildDepthGuardResult,
  recoverPendingFromDb,
  resolveAgentForGeneration,
} from './agentGenerationRecovery';
import {
  buildSyntheticToolResultMessages,
  buildToolResultMessages as buildToolResultMessagesFromOutputs,
  loadOutputMappingsByToolName,
  resolveToolOutputsResult,
  runNonStreamGeneration,
  runToolOutputsGeneration,
} from './agentNonStreamGeneration';
import { type GenerationInputMessage } from './generationInputMessages';
import { recordGenerationFailure } from './generationLifecycle';
import { createGenerationRecord } from './generations';
import { assertStreamingSupportsOutputSchema } from './outputSchema';
import { checkGenerationQuota, quotaBreachError } from './quotaEnforcement';
import { assertValidToolContextKeys } from './toolContext';

const log = createDebug('soat:generation');

export type { GenerationResult };

// ── Create Generation ─────────────────────────────────────────────────────

const dispatchGeneration = (args: {
  stream: boolean | undefined;
  ctx: GenerationContext;
  traceId: string;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  abortSignal?: AbortSignal;
}): Promise<GenerationResult | ReadableStream> => {
  if (args.stream) {
    assertStreamingSupportsOutputSchema(args.ctx.typedAgent.outputSchema);
    return runStreamGeneration({
      model: args.ctx.model,
      allMessages: args.ctx.allMessages,
      resolvedTools: args.ctx.resolvedTools,
      typedAgent: args.ctx.typedAgent,
      generationId: args.ctx.generationId,
      traceId: args.traceId,
      agentId: args.agentId,
      parentTraceId: args.parentTraceId ?? null,
      rootTraceId: args.rootTraceId ?? null,
    });
  }
  return runNonStreamGeneration({
    model: args.ctx.model,
    allMessages: args.ctx.allMessages,
    resolvedTools: args.ctx.resolvedTools,
    typedAgent: args.ctx.typedAgent,
    generationId: args.ctx.generationId,
    traceId: args.traceId,
    agentId: args.agentId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    abortSignal: args.abortSignal,
    toolContext: args.ctx.toolContext ?? null,
    remainingDepth: args.ctx.remainingDepth ?? null,
  });
};

const resolveContextAndRecord = async (args: {
  agentId: string;
  projectIds?: number[];
  messages: GenerationInputMessage[];
  authHeader?: string;
  authUser?: AuthUser;
  toolContext?: Record<string, string>;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  knowledgeConfig?: object;
  actionId?: string;
  triggerId?: string;
  orchestrationRunId?: string;
  nodeId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown> | null;
  guardrailContext?: Record<string, unknown> | null;
}): Promise<GenerationContext> => {
  const ctx = await buildGenerationContext({
    agentId: args.agentId,
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    knowledgeConfig: args.knowledgeConfig,
    guardrailContext: args.guardrailContext,
    // Carries the end user into config resolution: a staged rollout keys its
    // split on the actor behind this session, so the same end user keeps the
    // same agent version across calls.
    sessionId: args.sessionId,
  });

  // Awaited so the record reliably exists before the generation runs and a
  // failure can be persisted on it. Creation failures are non-fatal.
  await createGenerationRecord({
    publicId: ctx.generationId,
    projectId: ctx.typedAgent.project.id as number,
    agentId: args.agentId,
    traceId: args.traceId,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
    startedByPrincipalType: null,
    startedByPrincipalId: null,
    // End-user attribution is stored as typed FK columns rather than metadata
    // keys: it is identity the platform enforces (and later caps spend on), so
    // it must not live in the caller-writable metadata bag. The actor is
    // derived from the session, so only the session id travels.
    sessionId: args.sessionId ?? null,
    // Usage attribution and the served agent version: typed columns, for the
    // same reason. `metadata` carries only what the caller sent (F-15).
    actionId: args.actionId ?? null,
    triggerId: args.triggerId ?? null,
    orchestrationRunId: args.orchestrationRunId ?? null,
    nodeId: args.nodeId ?? null,
    agentVersion: ctx.agentVersion ?? null,
    metadata: args.metadata ?? null,
  }).catch((error) => {
    log(
      'resolveContextAndRecord: failed to create generation record generationId=%s error=%s',
      ctx.generationId,
      error instanceof Error ? error.message : String(error)
    );
  });

  return ctx;
};

// Returns a stop-here depth-guard result when the recursion budget is spent,
// or null to proceed. Extracted so `createGeneration` stays within its length
// budget.
const buildDepthGuardIfExhausted = async (args: {
  agentId: string;
  projectIds?: number[];
  maxDepth: number;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<GenerationResult | null> => {
  if (args.maxDepth > 0) return null;

  const depthAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
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

export type CreateGenerationArgs = {
  projectIds?: number[];
  agentId: string;
  messages: GenerationInputMessage[];
  stream?: boolean;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  authHeader?: string;
  authUser?: AuthUser;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
  knowledgeConfig?: object;
  actionId?: string;
  triggerId?: string;
  orchestrationRunId?: string;
  nodeId?: string;
  // End-user attribution: the session this generation runs in, from which the
  // actor is derived. Set by the session path; absent for direct API
  // generations, triggers, and orchestration nodes — no end user behind them.
  sessionId?: string;
  metadata?: Record<string, unknown> | null;
  // Caller-supplied guardrail context (guardrails.md — Guards and Guardrail
  // Context); the `context.*` namespace guards read at tool-dispatch time.
  guardrailContext?: Record<string, unknown> | null;
};

export const createGeneration = async (
  args: CreateGenerationArgs
): Promise<GenerationResult | ReadableStream> => {
  // Rejects a caller-supplied key that could not become a header before any
  // provider call or usage metering happens. The session path validates its
  // persisted keys at write time too; this covers the direct API, triggers,
  // orchestration nodes and nested `soat` tool calls.
  assertValidToolContextKeys(args.toolContext);

  const maxDepth = args.remainingDepth ?? 10;
  const traceId = args.traceId ?? generatePublicId(PUBLIC_ID_PREFIXES.trace);

  const depthGuard = await buildDepthGuardIfExhausted({
    agentId: args.agentId,
    projectIds: args.projectIds,
    maxDepth,
    traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
  });
  if (depthGuard) return depthGuard;

  // Pre-generation token/cost quota check (Quotas Phase 2). Runs before any
  // context building or provider call, so a breached budget blocks the new
  // generation with `QUOTA_EXCEEDED` and no usage is metered for it. Fails open
  // on an infrastructure error — a quota is cost control, not authorization, so
  // one window of unmetered spend beats blocking all generations on a DB blip.
  const quotaBreach = await checkGenerationQuota({
    agentId: args.agentId,
    projectIds: args.projectIds,
    // Carries the end user for `actor`-scope caps; the actor is derived from
    // the session, so this is the same attribution the usage event will record.
    sessionId: args.sessionId,
  });
  if (quotaBreach) throw quotaBreachError(quotaBreach);

  const ctx = await resolveContextAndRecord({
    agentId: args.agentId,
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    toolContext: args.toolContext,
    traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    initiatorGenerationId: args.initiatorGenerationId,
    remainingDepth: maxDepth,
    knowledgeConfig: args.knowledgeConfig,
    actionId: args.actionId,
    triggerId: args.triggerId,
    orchestrationRunId: args.orchestrationRunId,
    nodeId: args.nodeId,
    sessionId: args.sessionId,
    metadata: args.metadata,
    guardrailContext: args.guardrailContext,
  });

  log('createGeneration: agentId=%s stream=%s', args.agentId, args.stream);

  try {
    return await dispatchGeneration({
      stream: args.stream,
      ctx,
      traceId,
      agentId: args.agentId,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
      abortSignal: args.abortSignal,
    });
  } catch (error) {
    throw await recordGenerationFailure({
      generationId: ctx.generationId,
      traceId,
      error,
      model: ctx.model,
    });
  }
};

// ── Submit Tool Outputs ───────────────────────────────────────────────────

export const submitToolOutputs = async (args: {
  projectIds?: number[];
  agentId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
  authHeader?: string;
}): Promise<GenerationResult> => {
  let pending = pendingGenerations.get(args.generationId);

  // If not in memory (e.g. server restarted), recover from DB.
  if (!pending) {
    pending = await recoverPendingFromDb({
      generationId: args.generationId,
      agentId: args.agentId,
      projectIds: args.projectIds,
      authHeader: args.authHeader,
    });
  }
  if (!pending || pending.agentId !== args.agentId) {
    throw new DomainError(
      'GENERATION_NOT_FOUND',
      `Generation '${args.generationId}' not found or does not belong to agent '${args.agentId}'.`
    );
  }

  pendingGenerations.delete(args.generationId);

  const toolResultMessages = buildToolResultMessagesFromOutputs({
    toolOutputs: args.toolOutputs,
    pendingToolCalls: pending.pendingToolCalls,
    outputMappingsByToolName: await loadOutputMappingsByToolName(pending),
  });
  // Merge the results the guardrail gate synthesized for client calls it did not
  // release (class D / tripwire / pending_approval). They belong to the same
  // assistant turn, so the provider needs them alongside the client's outputs.
  const syntheticMessages = buildSyntheticToolResultMessages(
    pending.syntheticToolResults ?? []
  );
  const allMessages = [
    ...pending.messages,
    ...toolResultMessages,
    ...syntheticMessages,
  ];
  const system = (
    pending.messages as Array<{ role: string; content: string }>
  ).find((m) => {
    return m.role === 'system';
  })?.content;
  const nonSystemMessages = allMessages.filter((m) => {
    return (m as { role?: string }).role !== 'system';
  });

  const result = await runToolOutputsGeneration({
    generationId: args.generationId,
    pending,
    system,
    nonSystemMessages,
  });

  return resolveToolOutputsResult({
    generationId: args.generationId,
    agentId: args.agentId,
    pending,
    allMessages,
    result,
  });
};
