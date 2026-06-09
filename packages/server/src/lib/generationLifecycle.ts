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

  await Promise.all([
    updateGenerationRecord({
      publicId: args.generationId,
      status: 'failed',
      completedAt: new Date(),
      stopReason: 'error',
      error: errorPayload,
    }).catch(() => {}),
    recordTraceError({
      traceId: args.traceId,
      error: errorPayload,
    }).catch(() => {}),
  ]);

  if (args.error instanceof DomainError) {
    // Error responses bypass the caseTransform middleware, so meta keys are
    // written in snake_case to match the external REST contract.
    return new DomainError(args.error.code, args.error.message, {
      ...args.error.meta,
      generation_id: args.generationId,
      trace_id: args.traceId,
    });
  }

  return args.error;
};

export const fireCompletionSideEffects = (args: {
  generationId: string;
  pending: NonNullable<ReturnType<typeof pendingGenerations.get>>;
  result: { steps: unknown[]; finishReason: string };
  completedResult: GenerationResult;
}): void => {
  const prevSteps = args.pending.steps ?? [];
  const allSteps = [...prevSteps, ...serializeSteps(args.result.steps)];
  saveTrace({
    traceId: args.pending.traceId,
    projectId: args.pending.projectId,
    projectPublicId: args.pending.projectPublicId,
    agentId: args.pending.agentId,
    steps: allSteps,
    parentTraceId: args.pending.parentTraceId ?? undefined,
    rootTraceId: args.pending.rootTraceId ?? undefined,
  }).catch(() => {});
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'completed',
    completedAt: new Date(),
    stopReason: args.result.finishReason,
  }).catch(() => {});
  resolveProjectPublicId({ projectId: args.pending.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'agents.generation.completed',
        projectId: args.pending.projectId,
        projectPublicId,
        resourceType: 'generation',
        resourceId: args.generationId,
        data: args.completedResult as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );
};
