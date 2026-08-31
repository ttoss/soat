/**
 * The streaming generation path: the `streamText` call and everything a
 * finished stream persists.
 *
 * It sits next to `agentNonStreamGeneration.ts` rather than inside
 * `agentGenerationHelpers.ts`, which is where it grew — a module named
 * "helpers" holding one of the two run paths is how `buildPrepareStep` ended
 * up written twice (#911): the stream copy was unreachable from the non-stream
 * module, so it was re-implemented instead of shared.
 */
import type { LanguageModel, LanguageModelUsage, ModelMessage, Tool } from 'ai';
import { isStepCount, streamText } from 'ai';
import createDebug from 'debug';

import type { TypedAgent } from './agentGenerationTypes';
import {
  buildPrepareStep,
  resolveAgentStepRuleToolIdToName,
  type TurnToolChoice,
} from './agentStepRules';
import { recordGenerationFailure } from './generationLifecycle';
import { updateGenerationRecord } from './generations';
import { resolveMaxSteps, resolveStopReason } from './generationStopReason';
import {
  collectSystemInstructions,
  withoutSystemMessages,
} from './modelMessages';
import { routedMaxRetries } from './modelRouteExecutor';
import { saveRoutingMetadata } from './modelRouteMetadata';
import { isPlainObject } from './plainObject';
import {
  buildGenerationErrorPayload,
  toProviderDomainError,
} from './providerError';
import {
  findTextEncodedToolCall,
  textEncodedToolCallError,
} from './textEncodedToolCall';
import { recordTraceError, saveTrace, serializeSteps } from './traces';
import { recordGenerationUsage } from './usage';

const log = createDebug('soat:generation');

/**
 * Text of the step the run ended on. `generateText` exposes this as
 * `result.text` already; a stream's `onEnd` only gets the step array, so the
 * same "final step, never an earlier one" rule is spelled out here.
 */
const finalStepText = (steps: unknown[]): string => {
  const finalStep = steps.at(-1);
  if (!isPlainObject(finalStep)) return '';
  return typeof finalStep.text === 'string' ? finalStep.text : '';
};

/**
 * Records a streamed generation that ended on a text-encoded tool call as
 * failed, on both the generation record and the trace. Fire-and-forget like
 * every other `onEnd` write: the stream has already been delivered, so there
 * is no caller left to throw at.
 */
const recordStreamedTextEncodedToolCall = async (args: {
  generationId: string;
  traceId: string;
  toolName: string;
}): Promise<void> => {
  const error = buildGenerationErrorPayload(
    textEncodedToolCallError(args.toolName)
  );
  await Promise.allSettled([
    updateGenerationRecord({
      publicId: args.generationId,
      status: 'failed',
      completedAt: new Date(),
      stopReason: 'error',
      error,
    }),
    recordTraceError({ traceId: args.traceId, error }),
  ]);
};

/**
 * Everything a finished stream persists: the trace, the terminal status, the
 * routing stamp and the usage event. All fire-and-forget — the stream has
 * already been delivered, so there is no caller left to throw at.
 */
const fireStreamEndSideEffects = (args: {
  generationId: string;
  traceId: string;
  parentTraceId: string | null;
  rootTraceId: string | null;
  agentId: string;
  typedAgent: TypedAgent;
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  steps: unknown[];
  finishReason: string;
  usage?: LanguageModelUsage;
  /**
   * Whether `onError` already captured a provider failure. A stream that dies
   * *after* a step completed still reaches `onEnd`, and the terminal status
   * there belongs to the failure path — which records `failed` with the
   * provider's own error. Both writes target the same row, so without this the
   * `completed` write could land last and bury the failure.
   */
  failed: boolean;
}): void => {
  saveTrace({
    traceId: args.traceId,
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    agentId: args.agentId,
    generationId: args.generationId,
    steps: serializeSteps(args.steps),
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
  }).catch(() => {});

  // The blob has already gone down the wire, but the record of it can still
  // tell the truth — `failed` is what makes this findable on the generation and
  // the trace instead of only in whatever consumed the stream.
  const streamedToolCall = findTextEncodedToolCall({
    text: finalStepText(args.steps),
    toolNames: Object.keys(args.resolvedTools),
  });
  if (streamedToolCall) {
    void recordStreamedTextEncodedToolCall({
      generationId: args.generationId,
      traceId: args.traceId,
      toolName: streamedToolCall,
    });
  } else if (!args.failed) {
    updateGenerationRecord({
      publicId: args.generationId,
      status: 'completed',
      completedAt: new Date(),
      stopReason: resolveStopReason({
        finishReason: args.finishReason,
        stepCount: args.steps.length,
        maxSteps: args.typedAgent.maxSteps,
      }),
    }).catch(() => {});
  }

  saveRoutingMetadata({
    generationId: args.generationId,
    model: args.model,
  }).catch(
    /* istanbul ignore next -- fire-and-forget alongside the trace write */
    () => {}
  );
  // recordGenerationUsage never rejects (it catches internally), so `void`
  // marks the intentional fire-and-forget without an extra no-op handler.
  void recordGenerationUsage({
    generationId: args.generationId,
    model: args.typedAgent.model ?? '',
    usage: args.usage,
  });
};

/**
 * Persists a streamed generation that failed mid-flight and returns the error
 * to fail the stream with.
 *
 * A run that fails before any step completes never reaches `onEnd`, so nothing
 * else writes its terminal state and the record sat `in_progress` forever.
 * Errors are mapped as `callGenerateText` maps them, and awaited before the
 * stream fails so the record is truthful when the caller reads the error frame.
 */
const recordStreamFailure = async (args: {
  generationId: string;
  traceId: string;
  typedAgent: TypedAgent;
  model: LanguageModel;
  error: unknown;
}): Promise<unknown> => {
  // `TypedAgent.project.id` is `unknown` — the row is built from several
  // sources — so it is narrowed rather than asserted: when it is not a number
  // the failure is still persisted, just not announced.
  const projectId = args.typedAgent.project.id;
  return recordGenerationFailure({
    generationId: args.generationId,
    traceId: args.traceId,
    error: toProviderDomainError(args.error) ?? args.error,
    model: args.model,
    ...(typeof projectId === 'number'
      ? { projectId, projectPublicId: args.typedAgent.project.publicId }
      : {}),
  });
};

/**
 * Wraps `streamText`'s stream so a captured failure reaches the caller.
 *
 * `streamText` hands failures to `onError` and then closes the stream cleanly,
 * so the route read an ordinary end-of-stream and answered `200` with no error
 * (#1084). Chunks are forwarded as they arrive and the failure raised after the
 * last one, which keeps partial output and makes the route's `catch` — terminal
 * SSE error frame, no `[DONE]` — reachable.
 */
const withTerminalError = (args: {
  source: ReadableStream<string>;
  readStreamError: () => unknown;
  recordFailure: (error: unknown) => Promise<unknown>;
}): ReadableStream<string> => {
  const reader = args.source.getReader();
  return new ReadableStream<string>({
    pull: async (controller) => {
      const chunk = await reader.read();
      if (chunk.value !== undefined) {
        controller.enqueue(chunk.value);
      }
      if (!chunk.done) return;
      const streamError = args.readStreamError();
      if (streamError === undefined) {
        controller.close();
        return;
      }
      controller.error(await args.recordFailure(streamError));
    },
  });
};

export const runStreamGeneration = async (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  toolChoice: TurnToolChoice;
  generationId: string;
  traceId: string;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): Promise<ReadableStream> => {
  const system = collectSystemInstructions(args.allMessages);
  const nonSystemMessages = withoutSystemMessages(args.allMessages);
  const prepareStep = buildPrepareStep({
    stepRules: args.typedAgent.stepRules,
    logContext: 'stream',
    toolIdToName: await resolveAgentStepRuleToolIdToName(args.typedAgent),
  });
  log(
    'runStreamGeneration: agentId=%s toolCount=%d stepRulesCount=%d',
    args.agentId,
    Object.keys(args.resolvedTools).length,
    Array.isArray(args.typedAgent.stepRules)
      ? (args.typedAgent.stepRules as unknown[]).length
      : 0
  );
  log('runStreamGeneration: tools=%o', Object.keys(args.resolvedTools));
  // Captured, not acted on: `onError` fires mid-read, and the failure must not
  // overtake chunks already on their way to the caller.
  let streamError: unknown;
  const result = streamText({
    model: args.model,
    // Routed models own every attempt themselves (see `routedMaxRetries`).
    maxRetries: routedMaxRetries(args.model),
    instructions: system,
    messages: nonSystemMessages as ModelMessage[],
    tools:
      Object.keys(args.resolvedTools).length > 0
        ? args.resolvedTools
        : undefined,
    toolChoice: args.toolChoice,
    prepareStep,
    stopWhen: isStepCount(resolveMaxSteps(args.typedAgent.maxSteps)),
    temperature: (args.typedAgent.temperature as number) ?? undefined,
    onError: ({ error }) => {
      streamError = error;
    },
    onEnd: ({ steps, finishReason, usage }) => {
      fireStreamEndSideEffects({
        generationId: args.generationId,
        traceId: args.traceId,
        parentTraceId: args.parentTraceId ?? null,
        rootTraceId: args.rootTraceId ?? null,
        agentId: args.agentId,
        typedAgent: args.typedAgent,
        model: args.model,
        resolvedTools: args.resolvedTools,
        steps: steps as unknown[],
        finishReason,
        usage,
        failed: streamError !== undefined,
      });
    },
  });
  return withTerminalError({
    source: result.textStream,
    readStreamError: () => {
      return streamError;
    },
    recordFailure: (error) => {
      return recordStreamFailure({
        generationId: args.generationId,
        traceId: args.traceId,
        typedAgent: args.typedAgent,
        model: args.model,
        error,
      });
    },
  });
};
