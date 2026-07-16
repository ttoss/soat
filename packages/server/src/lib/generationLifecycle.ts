import type { LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { DomainError } from '../errors';
import type {
  GenerationResult,
  pendingGenerations,
} from './agentGenerationHelpers';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { updateGenerationRecord } from './generations';
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
  ]);

  // Error responses bypass the caseTransform middleware, so meta keys are
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
    emitEvent({
      type: 'agents.generation.completed',
      projectId: args.pending.projectId,
      projectPublicId,
      resourceType: 'generation',
      resourceId: args.generationId,
      data: args.completedResult as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
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
