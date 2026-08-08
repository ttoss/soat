import type { LanguageModel, LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { DomainError } from '../errors';
import type {
  GenerationResult,
  pendingGenerations,
} from './agentGenerationHelpers';
import { emitResourceEvent, resolveProjectPublicId } from './eventBus';
import { updateGenerationRecord } from './generations';
import { saveRoutingMetadata } from './modelRouteMetadata';
import { buildGenerationErrorPayload } from './providerError';
import { recordTraceError, saveTrace, serializeSteps } from './traces';
import { recordGenerationUsage } from './usage';

const log = createDebug('soat:generation');

/**
 * Persists a generation failure (status 'failed' + structured error payload
 * on both the generation record and the trace) and returns the error to
 * rethrow. DomainErrors are enriched with the generation and trace IDs so
 * callers can debug the failure post-mortem.
 */
export const recordGenerationFailure = async (args: {
  generationId: string;
  traceId: string;
  error: unknown;
  /** The model the failed turn ran on — a routed one stamps its attempts. */
  model?: LanguageModel;
}): Promise<unknown> => {
  const errorPayload = buildGenerationErrorPayload(args.error);

  log(
    'recordGenerationFailure: generationId=%s traceId=%s error=%o',
    args.generationId,
    args.traceId,
    errorPayload
  );

  // Persistence failures must not mask the original generation error.
  await Promise.allSettled([
    updateGenerationRecord({
      publicId: args.generationId,
      status: 'failed',
      completedAt: new Date(),
      stopReason: 'error',
      error: errorPayload,
    }),
    recordTraceError({
      traceId: args.traceId,
      error: errorPayload,
    }),
    // Every attempt the route burned is named on the generation even though it
    // ultimately failed — that is what makes the unmetered-failed-attempt gap
    // visible rather than silent.
    saveRoutingMetadata({ generationId: args.generationId, model: args.model }),
  ]);

  // Meta keys are
  // written in snake_case to match the external REST contract.
  if (args.error instanceof DomainError) {
    return new DomainError(args.error.code, args.error.message, {
      ...args.error.meta,
      generation_id: args.generationId,
      trace_id: args.traceId,
    });
  }

  // Wrap unexpected errors so the trace_id reaches the caller.
  const message =
    args.error instanceof Error ? args.error.message : 'Internal Server Error';
  return new DomainError('GENERATION_FAILED', message, {
    generation_id: args.generationId,
    trace_id: args.traceId,
  });
};

/**
 * Fails a continuation turn (the tool-outputs path) the way
 * `runCompletionSideEffects` completes one: the trace keeps every step of the
 * run — the earlier ones the pending state carried plus this turn's — so the
 * text that caused the failure is there to read, and only then is the failure
 * stamped on both records. Returns the error to rethrow.
 *
 * The continuation has no `try`/`catch` above it the way `createGeneration`
 * does, so a throw from that path would otherwise leave the generation stuck
 * in `requires_action` with nothing recorded.
 */
export const recordContinuationFailure = async (args: {
  generationId: string;
  pending: NonNullable<ReturnType<typeof pendingGenerations.get>>;
  steps: unknown[];
  error: unknown;
}): Promise<unknown> => {
  // `allSettled` rather than `.catch()`: a trace write that fails must not
  // mask the failure being recorded — the same reason `recordGenerationFailure`
  // above settles its writes instead of awaiting them bare.
  await Promise.allSettled([
    saveTrace({
      traceId: args.pending.traceId,
      projectId: args.pending.projectId,
      projectPublicId: args.pending.projectPublicId,
      agentId: args.pending.agentId,
      steps: [...(args.pending.steps ?? []), ...serializeSteps(args.steps)],
      parentTraceId: args.pending.parentTraceId ?? undefined,
      rootTraceId: args.pending.rootTraceId ?? undefined,
    }),
  ]);

  return recordGenerationFailure({
    generationId: args.generationId,
    traceId: args.pending.traceId,
    error: args.error,
    model: args.pending.resolvedModel,
  });
};

type CompletionSideEffectsArgs = {
  generationId: string;
  pending: NonNullable<ReturnType<typeof pendingGenerations.get>>;
  result: {
    steps: unknown[];
    finishReason: string;
    response?: { modelId?: string };
    usage?: LanguageModelUsage;
  };
  completedResult: GenerationResult;
};

const runCompletionSideEffects = async (
  args: CompletionSideEffectsArgs
): Promise<void> => {
  const prevSteps = args.pending.steps ?? [];
  const allSteps = [...prevSteps, ...serializeSteps(args.result.steps)];

  await Promise.allSettled([
    saveTrace({
      traceId: args.pending.traceId,
      projectId: args.pending.projectId,
      projectPublicId: args.pending.projectPublicId,
      agentId: args.pending.agentId,
      steps: allSteps,
      parentTraceId: args.pending.parentTraceId ?? undefined,
      rootTraceId: args.pending.rootTraceId ?? undefined,
    }),
    updateGenerationRecord({
      publicId: args.generationId,
      status: 'completed',
      completedAt: new Date(),
      stopReason: args.result.finishReason,
    }),
    saveRoutingMetadata({
      generationId: args.generationId,
      model: args.pending.resolvedModel,
    }),
    // The tool-outputs continuation is a separate completion path from
    // `buildCompletedGenerationResult`/`runStreamGeneration`'s `onEnd` — both
    // of which already meter usage. Without this, a generation that paused
    // for a client tool call never got a usage event, even though the
    // provider's response carried real usage.
    recordGenerationUsage({
      generationId: args.generationId,
      model: args.result.response?.modelId ?? '',
      usage: args.result.usage,
    }),
  ]);

  try {
    const projectPublicId = await resolveProjectPublicId({
      projectId: args.pending.projectId,
    });
    emitResourceEvent({
      type: 'agents.generation.completed',
      projectId: args.pending.projectId,
      projectPublicId,
      resourceType: 'generation',
      resourceId: args.generationId,
      data: args.completedResult,
    });
  } catch (error) {
    log(
      'runCompletionSideEffects: failed to emit completion event generationId=%s error=%s',
      args.generationId,
      error instanceof Error ? error.message : String(error)
    );
  }
};

/**
 * Fire-and-forget completion side effects: persists the trace, marks the
 * generation completed, and emits the completion event. Never throws.
 */
export const fireCompletionSideEffects = (
  args: CompletionSideEffectsArgs
): void => {
  void runCompletionSideEffects(args);
};
