import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';
import type { AuthUser } from 'src/Context';

import { DomainError } from '../errors';
import {
  buildGenerationContext,
  type GenerationContext,
} from './agentGenerationContext';
import { pendingGenerations } from './agentGenerationHelpers';
import {
  buildDepthGuardResult,
  recoverPendingFromDb,
  resolveAgentForGeneration,
} from './agentGenerationRecovery';
import { type GenerationResult } from './agentGenerationTypes';
import {
  buildSyntheticToolResultMessages,
  buildToolResultMessages as buildToolResultMessagesFromOutputs,
  loadOutputMappingsByToolName,
  resolveToolOutputsResult,
  runNonStreamGeneration,
  runToolOutputsGeneration,
} from './agentNonStreamGeneration';
import { runStreamGeneration } from './agentStreamGeneration';
import { type ChainLineage, resolveChainOrRefuse } from './generationChain';
import { type GenerationInputMessage } from './generationInputMessages';
import { recordGenerationFailure } from './generationLifecycle';
import { createGenerationRecord } from './generations';
import {
  collectSystemInstructions,
  withoutSystemMessages,
} from './modelMessages';
import { resolveStartingPrincipal } from './orchestrationRunToken';
import { assertStreamingSupportsOutputSchema } from './outputSchema';
import { startedByPrincipalColumns } from './principals';
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
      toolChoice: args.ctx.toolChoice,
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
    toolChoice: args.ctx.toolChoice,
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
  rootGenerationId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  knowledgeConfig?: object;
  actionId?: string;
  triggerId?: string;
  orchestrationRunId?: string;
  nodeId?: string;
  nodeAttempt?: number;
  sessionId?: string;
  metadata?: Record<string, unknown> | null;
  guardrailContext?: Record<string, unknown> | null;
  pinnedAgentVersion?: number | null;
  source?: string | null;
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
    pinnedAgentVersion: args.pinnedAgentVersion,
    initiatorGenerationId: args.initiatorGenerationId,
  });

  // Persisted rather than left to the request: work resuming after the request
  // is gone — an approved tool call's continuation days later — re-mints its
  // credential from this pair (#894).
  const principal = resolveStartingPrincipal({
    authUser: args.authUser,
    authHeader: args.authHeader,
  });

  // Awaited so the record reliably exists before the generation runs and a
  // failure can be persisted on it. Creation failures are non-fatal.
  await createGenerationRecord({
    publicId: ctx.generationId,
    projectId: ctx.typedAgent.project.id as number,
    agentId: args.agentId,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    rootGenerationId: args.rootGenerationId,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
    ...startedByPrincipalColumns(principal),
    // Typed FK columns, not metadata keys: this is identity the platform
    // enforces and caps spend on, so it must not live in a caller-writable bag.
    sessionId: args.sessionId ?? null,
    // Usage attribution and the served agent version: typed columns, for the
    // same reason. `metadata` carries only what the caller sent (F-15).
    actionId: args.actionId ?? null,
    triggerId: args.triggerId ?? null,
    orchestrationRunId: args.orchestrationRunId ?? null,
    nodeId: args.nodeId ?? null,
    // Unlike its siblings above, this needs no `?? null`: `attributionColumns`
    // already normalizes an absent attribution field to null. Adding one back
    // would also push this function past its complexity ceiling.
    nodeAttempt: args.nodeAttempt,
    agentVersion: ctx.agentVersion ?? null,
    source: args.source ?? null,
    metadata: args.metadata ?? null,
    // The turn's own input, so a completed generation stays promotable into an
    // eval dataset item long after the request that produced it is gone.
    inputMessages: ctx.inputMessages,
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
  // The orchestration node's 1-based retry attempt, completing the
  // run + node + attempt replay identity. Absent outside an orchestration node.
  nodeAttempt?: number;
  // End-user attribution: the session this generation runs in, from which the
  // actor is derived. Set by the session path; absent for direct API
  // generations, triggers, and orchestration nodes — no end user behind them.
  sessionId?: string;
  metadata?: Record<string, unknown> | null;
  // Caller-supplied guardrail context (guardrails.md — Guards and Guardrail
  // Context); the `context.*` namespace guards read at tool-dispatch time.
  guardrailContext?: Record<string, unknown> | null;
  // Forces one archived agent version instead of letting release assignment
  // pick per generation. Set by eval runs, which must measure every item
  // against the same config (the evaluations module doc — Version pinning).
  pinnedAgentVersion?: number | null;
  // Copied onto the usage event at the metering choke point, so verification
  // spend stays separable from production spend.
  source?: string | null;
};

/**
 * Everything that must happen before the provider is called: input validation,
 * the depth guard, the quota check, and writing the `in_progress` generation
 * record. Split out so the blocking and background entry points share one
 * ordering — a background caller must still get a real `400`/`404`/`429` for a
 * bad request, and must still get a generation id that already exists in the
 * database before the response is written.
 */
type GenerationPrep =
  | { kind: 'short_circuit'; result: GenerationResult }
  | ({ kind: 'ready'; ctx: GenerationContext; traceId: string } & ChainLineage);

const prepareGeneration = async (
  args: CreateGenerationArgs
): Promise<GenerationPrep> => {
  // Rejects a key that could not become a header before any provider call or
  // metering happens, covering every path but the session's own write-time check.
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
  if (depthGuard) return { kind: 'short_circuit', result: depthGuard };

  // A declared initiator is what makes a turn a continuation: its lineage and
  // its budget are both resolved from that one field.
  const chain = await resolveChainOrRefuse({
    agentId: args.agentId,
    projectIds: args.projectIds,
    initiatorGenerationId: args.initiatorGenerationId,
    traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
  });
  if (chain.kind === 'refused') {
    return { kind: 'short_circuit', result: chain.result };
  }
  const { lineage } = chain;

  // Before any context building or provider call, so a breached budget meters
  // nothing. Fails open on an infrastructure error: a quota is cost control,
  // not authorization, so one unmetered window beats blocking every generation.
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
    ...lineage,
    initiatorGenerationId: args.initiatorGenerationId,
    remainingDepth: maxDepth,
    knowledgeConfig: args.knowledgeConfig,
    actionId: args.actionId,
    triggerId: args.triggerId,
    orchestrationRunId: args.orchestrationRunId,
    nodeId: args.nodeId,
    nodeAttempt: args.nodeAttempt,
    sessionId: args.sessionId,
    metadata: args.metadata,
    guardrailContext: args.guardrailContext,
    pinnedAgentVersion: args.pinnedAgentVersion,
    source: args.source,
  });

  return { kind: 'ready', ctx, traceId, ...lineage };
};

/**
 * The project a failed turn belongs to, in the shape `recordGenerationFailure`
 * needs to announce it. `TypedAgent.project.id` is `unknown` — the row is built
 * from several sources — so it is narrowed rather than asserted: when it is not
 * a number the failure is still persisted, just not announced.
 */
const failureProject = (ctx: GenerationContext) => {
  const id = ctx.typedAgent.project.id;
  return typeof id === 'number'
    ? { projectId: id, projectPublicId: ctx.typedAgent.project.publicId }
    : {};
};

export const createGeneration = async (
  args: CreateGenerationArgs
): Promise<GenerationResult | ReadableStream> => {
  const prep = await prepareGeneration(args);
  if (prep.kind === 'short_circuit') return prep.result;
  const { ctx, traceId, parentTraceId, rootTraceId } = prep;

  log('createGeneration: agentId=%s stream=%s', args.agentId, args.stream);

  try {
    return await dispatchGeneration({
      stream: args.stream,
      ctx,
      traceId,
      agentId: args.agentId,
      parentTraceId,
      rootTraceId,
      abortSignal: args.abortSignal,
    });
  } catch (error) {
    throw await recordGenerationFailure({
      generationId: ctx.generationId,
      traceId,
      error,
      model: ctx.model,
      ...failureProject(ctx),
    });
  }
};

/** The handle a background generation hands back in place of a result. */
export type AcceptedGeneration = {
  id: string;
  traceId: string;
  status: 'accepted';
};

/**
 * Starts a generation and returns as soon as it is admitted, leaving the
 * provider call to run in the background. The caller polls
 * `GET /generations/{id}` with the returned id, which is why the prep phase —
 * including the `in_progress` record write — is awaited first: a handle that
 * raced the record would 404 on the caller's first poll.
 *
 * A failure after admission is recorded on the generation record (the caller
 * reads it as `status: failed`), never rethrown — there is no request left to
 * receive it.
 */
export const startGeneration = async (
  args: CreateGenerationArgs
): Promise<AcceptedGeneration> => {
  const prep = await prepareGeneration(args);
  if (prep.kind === 'short_circuit') {
    // The depth guard already produced a terminal record; hand back its ids so
    // the caller polls the same generation it would have received inline.
    return {
      id: prep.result.id,
      traceId: prep.result.traceId,
      status: 'accepted',
    };
  }
  const { ctx, traceId, parentTraceId, rootTraceId } = prep;

  log(
    'startGeneration: agentId=%s generationId=%s',
    args.agentId,
    ctx.generationId
  );

  void dispatchGeneration({
    // Streaming needs the request that is already being answered, so a
    // background generation is never a stream; the route rejects the
    // combination rather than silently dropping the caller's stream.
    stream: false,
    ctx,
    traceId,
    agentId: args.agentId,
    parentTraceId,
    rootTraceId,
    abortSignal: args.abortSignal,
  }).catch(async (error) => {
    // A `try` rather than a second `.catch`: recording is best-effort (the
    // request is already gone), but the swallow must not itself become an
    // unreachable function on a fire-and-forget path.
    try {
      await recordGenerationFailure({
        generationId: ctx.generationId,
        traceId,
        error,
        model: ctx.model,
        ...failureProject(ctx),
      });
    } catch {
      log('startGeneration: failed to record generation failure');
    }
  });

  return { id: ctx.generationId, traceId, status: 'accepted' };
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
  const system = collectSystemInstructions(pending.messages);
  const nonSystemMessages = withoutSystemMessages(allMessages);

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
