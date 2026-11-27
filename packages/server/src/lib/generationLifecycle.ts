import type { LanguageModel, LanguageModelUsage } from 'ai';
import createDebug from 'debug';

import { DomainError } from '../errors';
import type { PendingGeneration } from './agentGenerationTypes';
import type { TurnCitations } from './citations';
import { segmentAbortReason } from './generationSegment';
import { logSettleFailure, settleGeneration } from './generationSettle';
import { resolveStopReason } from './generationStopReason';
import { routedAiProviderId, servedModelName } from './modelRouteExecutor';
import { saveRoutingMetadata } from './modelRouteMetadata';
import { buildGenerationErrorPayload, usageFromFailure } from './providerError';
import { type ReplayedWindow, replayRefusal } from './replayRefusal';
import { recordTraceError } from './traces';
import {
  reportedModelOf,
  reportedModelOfSteps,
  spentUsageOf,
  sumStepUsage,
} from './turnSpend';
import { recordGenerationUsage } from './usage';
import type { GenerationTurnFacts } from './usageAgentPricing';

// A failed segment's facts: no step completed, and it stopped on the error.
const FAILED_TURN: GenerationTurnFacts = {
  steps: [],
  finishReason: 'error',
  budget: { maxSteps: null, outputSchema: null },
  outcome: 'error',
};

const log = createDebug('soat:generation');

/**
 * The one ingress for a generation segment's usage event: the model name and
 * provider it is billed to are both read off the model the segment ran on, so
 * no path answers either question for itself.
 */
export const recordSegmentUsage = (args: {
  generationId: string;
  model: LanguageModel;
  /** The id the provider answered with; absent when it reported none. */
  reportedModelId: string | undefined;
  usage: LanguageModelUsage | undefined;
  stepsAlreadySpent: number;
  turn: GenerationTurnFacts;
}): Promise<void> => {
  return recordGenerationUsage({
    generationId: args.generationId,
    model: servedModelName({
      model: args.model,
      reportedModelId: args.reportedModelId,
    }),
    usage: args.usage,
    aiProviderId: routedAiProviderId(args.model),
    stepsAlreadySpent: args.stepsAlreadySpent,
    turn: args.turn,
  });
};

// The tokens a failed segment spent, when the provider reported any.
const meterFailedSegment = (args: {
  generationId: string;
  model: LanguageModel;
  reportedModelId: string | undefined;
  usage: LanguageModelUsage | undefined;
  stepsAlreadySpent: number;
}): Promise<void>[] => {
  if (!args.usage) return [];
  return [recordSegmentUsage({ ...args, turn: FAILED_TURN })];
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
  model: LanguageModel;
  /**
   * The project the turn belongs to, where the failure is announced — the only
   * channel a background caller has (it already got its `202` and went away).
   */
  projectId: number;
  /**
   * Token usage the turn spent before it failed, from `usageFromFailure`. A
   * failure that never reached the model has none; one that failed *on* the
   * model's answer (output_schema) has counts the provider already billed for,
   * and dropping them would under-report real spend. Metering is keyed, so a
   * caller that records the same failure twice still writes one event.
   */
  usage?: LanguageModelUsage;
  /**
   * The model id the provider answered the segment's completed calls with,
   * when a caller mapped the error and so lost what it carried.
   */
  reportedModelId?: string;
  /** Steps the turn spent before the failed segment — keys its usage event. */
  stepsAlreadySpent: number;
  /** The conversation positions the turn replayed; `null` when it replays none. */
  replayed: ReplayedWindow | null;
}): Promise<unknown> => {
  // A segment cancelled at its deadline or on losing its lease fails for that
  // reason, whatever the cancelled call threw.
  const cause = replayRefusal({
    error: segmentAbortReason(args.generationId) ?? args.error,
    replayed: args.replayed,
  });
  const errorPayload = buildGenerationErrorPayload(cause);
  // Derived here so no failure path has to remember to pass it: `usage` is only
  // supplied explicitly by a caller that mapped the error before handing it over
  // (the mapped `DomainError` carries no counts).
  const usage =
    args.usage ?? spentUsageOf(args.error) ?? usageFromFailure(args.error);

  log(
    'recordGenerationFailure: generationId=%s traceId=%s code=%s',
    args.generationId,
    args.traceId,
    errorPayload.code
  );

  // Persistence failures must not mask the original generation error. The
  // settle announces `generations.failed`: without it, the only way to learn a
  // background generation died is to poll the record.
  await settleGeneration({
    generationId: args.generationId,
    fence: 'lease',
    outcome: { status: 'failed', error: errorPayload },
    effects: () => {
      return [
        recordTraceError({ traceId: args.traceId, error: errorPayload }),
        // Every attempt the route burned is named on the generation even
        // though it ultimately failed, so an unmetered failed attempt shows.
        saveRoutingMetadata({
          generationId: args.generationId,
          model: args.model,
        }),
        // The provider billed for the tokens whether or not the answer could
        // be used, so omitting them understates every roll-up that reads them.
        ...meterFailedSegment({
          ...args,
          reportedModelId: args.reportedModelId ?? reportedModelOf(args.error),
          usage,
        }),
      ];
    },
  }).catch(logSettleFailure(args.generationId));

  // Meta keys are
  // written in snake_case to match the external REST contract.
  if (cause instanceof DomainError) {
    return new DomainError(cause.code, cause.message, {
      ...cause.meta,
      generation_id: args.generationId,
      trace_id: args.traceId,
    });
  }

  // Wrap unexpected errors so the trace_id reaches the caller.
  const message =
    cause instanceof Error ? cause.message : 'Internal Server Error';
  return new DomainError('GENERATION_FAILED', message, {
    generation_id: args.generationId,
    trace_id: args.traceId,
  });
};

/**
 * Fails a continuation turn (the tool-outputs path): the trace already holds
 * every step of the run, recorded as each ended, so the text that caused the
 * failure is there to read. Returns the error to rethrow.
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
  return recordGenerationFailure({
    generationId: args.generationId,
    traceId: args.pending.traceId,
    error: args.error,
    model: args.pending.resolvedModel,
    projectId: args.pending.projectId,
    // Every call the segment completed was billed, the one whose answer
    // failed `output_schema` included.
    usage: sumStepUsage(args.steps) ?? usageFromFailure(args.error),
    reportedModelId: reportedModelOfSteps(args.steps),
    stepsAlreadySpent: args.pending.stepCount,
    replayed: args.pending.replayed,
  });
};

type CompletionSideEffectsArgs = {
  generationId: string;
  pending: PendingGeneration;
  result: {
    steps: unknown[];
    finishReason: string;
    text: string;
    response?: { modelId?: string };
  };
  /** The answer after `resolveTurnCitations`. */
  cited: { content: string; turn: TurnCitations | null };
};

/**
 * Meters one `generateText` call of a turn — unless it never called the model.
 * A segment that spent nothing (a turn arriving at `submit-tool-outputs` with
 * its step budget already spent) would file a zero-token event against an
 * unknown model, on the same generation as the calls that did consume tokens.
 */
export const meterTurnSegment = (
  args: Parameters<typeof recordSegmentUsage>[0]
): Promise<void> => {
  if (args.usage === undefined) return Promise.resolve();
  return recordSegmentUsage(args);
};

/** Meters the segment that finishes a continuation turn. */
export const meterContinuationSegment = (args: {
  generationId: string;
  pending: PendingGeneration;
  result: {
    steps: unknown[];
    finishReason: string;
    response?: { modelId?: string };
    usage?: LanguageModelUsage;
  };
}): Promise<void> => {
  return meterTurnSegment({
    generationId: args.generationId,
    model: args.pending.resolvedModel,
    reportedModelId: args.result.response?.modelId,
    usage: args.result.usage,
    stepsAlreadySpent: args.pending.stepCount,
    turn: {
      steps: args.result.steps,
      finishReason: args.result.finishReason,
      budget: args.pending.agentConfig,
      outcome: 'ok',
    },
  });
};

const runCompletionSideEffects = async (
  args: CompletionSideEffectsArgs
): Promise<void> => {
  await settleGeneration({
    generationId: args.generationId,
    fence: 'lease',
    outcome: {
      status: 'completed',
      stopReason: resolveStopReason({
        finishReason: args.result.finishReason,
        // The turn's steps, not this segment's: a turn spends one budget
        // across every pause it takes.
        stepCount: args.pending.stepCount + args.result.steps.length,
        budget: args.pending.agentConfig,
      }),
      assistantContent: args.cited.content,
      citations: args.cited.turn,
    },
    effects: () => {
      return [
        saveRoutingMetadata({
          generationId: args.generationId,
          model: args.pending.resolvedModel,
        }),
      ];
    },
  }).catch(logSettleFailure(args.generationId));
};

/**
 * Fire-and-forget completion side effects: marks the
 * generation completed, and emits the completion event. Never throws.
 */
export const fireCompletionSideEffects = (
  args: CompletionSideEffectsArgs
): void => {
  void runCompletionSideEffects(args);
};
