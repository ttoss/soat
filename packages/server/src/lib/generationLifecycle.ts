import type { LanguageModel, LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { DomainError } from '../errors';
import type {
  GenerationResult,
  PendingGeneration,
} from './agentGenerationTypes';
import { emitResourceEvent, resolveProjectPublicId } from './eventBus';
import { updateGenerationRecord } from './generations';
import { resolveStopReason } from './generationStopReason';
import { routedAiProviderId } from './modelRouteExecutor';
import { saveRoutingMetadata } from './modelRouteMetadata';
import { buildGenerationErrorPayload, usageFromFailure } from './providerError';
import { recordTraceError, saveTrace, serializeSteps } from './traces';
import { recordGenerationUsage } from './usage';

const log = createDebug('soat:generation');

// `LanguageModel` is either the id itself or a routed instance carrying one. An
// absent model meters as the empty string, as the completion path does.
const modelIdOf = (model: LanguageModel | undefined): string => {
  if (model === undefined) return '';
  return typeof model === 'string' ? model : model.modelId;
};

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
  /**
   * The project the turn belongs to. Optional only because the failure must be
   * *persisted* even from a path that cannot name it; when both are present the
   * failure is also announced, which is the only channel a background caller
   * has (it already got its `202` and went away).
   */
  projectId?: number;
  projectPublicId?: string;
  /**
   * Token usage the turn spent before it failed, from `usageFromFailure`. A
   * failure that never reached the model has none; one that failed *on* the
   * model's answer (output_schema) has counts the provider already billed for,
   * and dropping them would under-report real spend. Metering is keyed, so a
   * caller that records the same failure twice still writes one event.
   */
  usage?: LanguageModelUsage;
}): Promise<unknown> => {
  const errorPayload = buildGenerationErrorPayload(args.error);
  // Derived here so no failure path has to remember to pass it: `usage` is only
  // supplied explicitly by a caller that mapped the error before handing it over
  // (the mapped `DomainError` carries no counts).
  const usage = args.usage ?? usageFromFailure(args.error);

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
    // The provider billed for the tokens whether or not the answer could be
    // used, so omitting them understates every roll-up that reads them.
    ...(usage
      ? [
          recordGenerationUsage({
            generationId: args.generationId,
            model: modelIdOf(args.model),
            usage,
            aiProviderId: args.model ? routedAiProviderId(args.model) : null,
          }),
        ]
      : []),
  ]);

  // Without this, the only way to learn a background generation died is to poll
  // the record. Wrapped so emitting can never mask the original error.
  if (args.projectId !== undefined && args.projectPublicId !== undefined) {
    try {
      emitResourceEvent({
        type: 'agents.generation.failed',
        projectId: args.projectId,
        projectPublicId: args.projectPublicId,
        resourceType: 'generation',
        resourceId: args.generationId,
        // snake_case: an event payload is a wire surface, reaching subscribers
        // through the webhook dispatcher verbatim.
        data: {
          id: args.generationId,
          trace_id: args.traceId,
          status: 'failed',
          error: errorPayload,
        },
      });
    } catch (error) {
      log(
        'recordGenerationFailure: failed to emit failure event generationId=%s error=%s',
        args.generationId,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

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
  pending: PendingGeneration;
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
      generationId: args.generationId,
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
    // The continuation fails on the model's answer the same way the initial
    // turn does, and its tokens were billed the same way.
    usage: usageFromFailure(args.error),
  });
};

type CompletionSideEffectsArgs = {
  generationId: string;
  pending: PendingGeneration;
  result: {
    steps: unknown[];
    finishReason: string;
    response?: { modelId?: string };
    usage?: LanguageModelUsage;
  };
  completedResult: GenerationResult;
};

/**
 * Meters the response that completed the turn — unless there was none. A
 * segment that never called the model (a turn arriving at
 * `submit-tool-outputs` with its step budget already spent) consumed nothing,
 * and metering it would file a zero-token event against an unknown model, on
 * the same generation as the calls that did consume tokens.
 */
const meterCompletion = (args: CompletionSideEffectsArgs): Promise<void> => {
  if (args.result.usage === undefined) return Promise.resolve();
  return recordGenerationUsage({
    generationId: args.generationId,
    model: args.result.response?.modelId ?? '',
    usage: args.result.usage,
    aiProviderId: routedAiProviderId(args.pending.resolvedModel),
  });
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
      generationId: args.generationId,
      steps: allSteps,
      parentTraceId: args.pending.parentTraceId ?? undefined,
      rootTraceId: args.pending.rootTraceId ?? undefined,
    }),
    updateGenerationRecord({
      publicId: args.generationId,
      status: 'completed',
      completedAt: new Date(),
      stopReason: resolveStopReason({
        finishReason: args.result.finishReason,
        // The turn's steps, not this segment's: a turn spends one budget
        // across every pause it takes.
        stepCount: allSteps.length,
        maxSteps: args.pending.agentConfig.maxSteps,
      }),
    }),
    saveRoutingMetadata({
      generationId: args.generationId,
      model: args.pending.resolvedModel,
    }),
    // A separate completion path from the two that already meter usage: a
    // generation that paused for a client tool is metered here, on the response
    // that finishes it.
    meterCompletion(args),
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
