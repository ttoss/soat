/**
 * The streaming generation path: the `streamText` call and everything a
 * finished stream persists.
 *
 * It sits next to `agentNonStreamGeneration.ts` rather than inside
 * `agentGenerationHelpers.ts`, which is where it grew — a module named
 * "helpers" holding one of the two run paths is how `buildPrepareStep` ended
 * up written twice: the stream copy was unreachable from the non-stream
 * module, so it was re-implemented instead of shared.
 */
import type { LanguageModel, LanguageModelUsage, ModelMessage, Tool } from 'ai';
import { streamText } from 'ai';
import createDebug from 'debug';

import type { GenerationResult, TypedAgent } from './agentGenerationTypes';
import { modelCallSettings } from './agentModelSettings';
import { settleInitialClientCalls } from './agentNonStreamGeneration';
import {
  buildPrepareStep,
  resolveAgentStepRuleToolIdToName,
  type TurnToolChoice,
} from './agentStepRules';
import { resolveAnswerStep, resolveStopWhen } from './agentStopConditions';
import { citationMarkupStripStream } from './citationMarkup';
import { resolveTurnCitations, type TurnCitations } from './citations';
import {
  recordGenerationFailure,
  recordSegmentUsage,
} from './generationLifecycle';
import type { GenerationProvenance } from './generationProvenance';
import { segmentCallOptions } from './generationSegment';
import { logSettleFailure, settleGeneration } from './generationSettle';
import { resolveStopReason } from './generationStopReason';
import {
  collectSystemInstructions,
  withoutSystemMessages,
} from './modelMessages';
import { routedMaxRetries } from './modelRouteExecutor';
import { saveRoutingMetadata } from './modelRouteMetadata';
import {
  buildGenerationErrorPayload,
  toProviderDomainError,
} from './providerError';
import type { ReplayedWindow } from './replayRefusal';
import {
  findTextEncodedToolCall,
  textEncodedToolCallError,
} from './textEncodedToolCall';
import { recordTraceError } from './traces';
import { turnStepTarget } from './traceStepStore';
import { carrySpentUsage, reportedModelOf, spentUsageOf } from './turnSpend';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:generation');

/**
 * Records a streamed generation that ended on a text-encoded tool call as
 * failed, on both the generation record and the trace. Fire-and-forget like
 * every other `onEnd` write: the stream has already been delivered, so there
 * is no caller left to throw at.
 */
const recordStreamedTextEncodedToolCall = (args: {
  generationId: string;
  traceId: string;
  toolName: string;
  usageWrite: Promise<void>;
}): Promise<boolean> => {
  const error = buildGenerationErrorPayload(
    textEncodedToolCallError(args.toolName)
  );
  return settleGeneration({
    generationId: args.generationId,
    fence: 'lease',
    outcome: { status: 'failed', error },
    effects: () => {
      return [
        recordTraceError({ traceId: args.traceId, error }),
        args.usageWrite,
      ];
    },
  });
};

/**
 * Everything a finished stream persists: the trace, the terminal status, the
 * routing stamp, the usage event and, for a completed turn,
 * `generations.completed`. All fire-and-forget — the stream has already been
 * delivered, so there is no caller left to throw at.
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
  /** The text of the step the run ended on, never an earlier one's. */
  finalText: string;
  /** {@link finalText} after `resolveTurnCitations`. */
  cited: { content: string; turn: TurnCitations | null };
  finishReason: string;
  usage?: LanguageModelUsage;
  /** The model id the provider answered with. */
  reportedModelId?: string;
  /**
   * Whether `onError` already captured a provider failure. A stream that dies
   * *after* a step completed still reaches `onEnd`, and the terminal status
   * there belongs to the failure path — which records `failed` with the
   * provider's own error. Both writes target the same row, so without this the
   * `completed` write could land last and bury the failure.
   */
  failed: boolean;
}): void => {
  saveRoutingMetadata({
    generationId: args.generationId,
    model: args.model,
  }).catch(
    /* istanbul ignore next -- fire-and-forget */
    () => {}
  );
  // Never rejects: `recordGenerationUsage` beneath it catches internally.
  const usageWrite = recordSegmentUsage({
    generationId: args.generationId,
    model: args.model,
    reportedModelId: args.reportedModelId,
    usage: args.usage,
    stepsAlreadySpent: 0,
    turn: {
      steps: args.steps,
      finishReason: args.finishReason,
      budget: args.typedAgent,
      outcome: args.failed ? 'error' : 'ok',
    },
  });

  // The blob has already gone down the wire, but the record of it can still
  // tell the truth — `failed` is what makes this findable on the generation and
  // the trace instead of only in whatever consumed the stream.
  const streamedToolCall = findTextEncodedToolCall({
    text: args.finalText,
    toolNames: Object.keys(args.resolvedTools),
  });
  if (streamedToolCall) {
    void recordStreamedTextEncodedToolCall({
      generationId: args.generationId,
      traceId: args.traceId,
      toolName: streamedToolCall,
      usageWrite,
    }).catch(logSettleFailure(args.generationId));
    return;
  }
  if (args.failed) return;
  // After the usage write, as the non-stream path settles after metering: the
  // event carries the record as `GET` then answers it.
  void settleGeneration({
    generationId: args.generationId,
    fence: 'lease',
    outcome: {
      status: 'completed',
      stopReason: resolveStopReason({
        finishReason: args.finishReason,
        stepCount: args.steps.length,
        budget: args.typedAgent,
      }),
      assistantContent: args.cited.content,
      citations: args.cited.turn,
    },
    effects: () => {
      return [usageWrite];
    },
  }).catch(logSettleFailure(args.generationId));
};

/**
 * Persists a streamed generation that failed mid-flight and returns the error
 * to fail the stream with.
 *
 * A run that fails before any step completes never reaches `onEnd`, so nothing
 * else writes its terminal state and the record sat `running` forever.
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
  return recordGenerationFailure({
    generationId: args.generationId,
    traceId: args.traceId,
    error: toProviderDomainError(args.error) ?? args.error,
    // Read before the mapping, which builds a new error.
    usage: spentUsageOf(args.error),
    reportedModelId: reportedModelOf(args.error),
    model: args.model,
    projectId: args.typedAgent.project.id,
    stepsAlreadySpent: 0,
    // A conversation turn is never streamed.
    replayed: null,
  });
};

/**
 * A text delta, or the generation a turn that did not complete from the
 * stream itself ended on — paused on a client tool, or resumed past a gated
 * one — which only its record can tell the caller.
 */
export type StreamedGenerationPart =
  string | { generation: GenerationResult } | { citations: TurnCitations };

/**
 * Wraps `streamText`'s stream so a captured failure reaches the caller.
 *
 * `streamText` hands failures to `onError` and then closes the stream cleanly,
 * so the route read an ordinary end-of-stream and answered `200` with no error.
 * Chunks are forwarded as they arrive and the failure raised after the
 * last one, which keeps partial output and makes the route's `catch` — terminal
 * SSE error frame, no `[DONE]` — reachable.
 */
const withTerminalError = (args: {
  source: ReadableStream<string>;
  readStreamError: () => unknown;
  readTerminalGeneration: () => GenerationResult | undefined;
  readCitations: () => TurnCitations | null;
  recordFailure: (error: unknown) => Promise<unknown>;
}): ReadableStream<StreamedGenerationPart> => {
  const reader = args.source.getReader();
  return new ReadableStream<StreamedGenerationPart>({
    pull: async (controller) => {
      const chunk = await reader.read();
      if (chunk.value !== undefined) {
        controller.enqueue(chunk.value);
      }
      if (!chunk.done) return;
      const streamError = args.readStreamError();
      if (streamError === undefined) {
        const generation = args.readTerminalGeneration();
        if (generation) controller.enqueue({ generation });
        const citations = args.readCitations();
        if (citations) controller.enqueue({ citations });
        controller.close();
        return;
      }
      controller.error(await args.recordFailure(streamError));
    },
  });
};

type StreamRunArgs = {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  toolsAuthority: WorkAuthority | null;
  typedAgent: TypedAgent;
  toolChoice: TurnToolChoice;
  generationId: string;
  traceId: string;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
  provenance: GenerationProvenance;
  /** The conversation positions the turn replays; `null` when it replays none. */
  replayed: ReplayedWindow | null;
  /** The request's own cancellation, beside the segment's. */
  abortSignal?: AbortSignal;
  /** Strips citation markup from the text and verifies it at the end. */
  citesSources: boolean;
};

/** What `streamText` hands `onEnd` that the turn's records are built from. */
type StreamEnd = {
  steps: unknown[];
  text: string;
  finishReason: string;
  usage?: LanguageModelUsage;
  response: { modelId?: string };
  responseMessages: unknown[];
};

/**
 * Pauses a streamed turn that proposed client calls, as the unstreamed path
 * does. `null` when it proposed none.
 */
const settleStreamedClientCalls = (args: {
  run: StreamRunArgs;
  end: StreamEnd;
}): Promise<GenerationResult | null> => {
  const { run, end } = args;
  return settleInitialClientCalls({
    generationId: run.generationId,
    traceId: run.traceId,
    parentTraceId: run.parentTraceId ?? null,
    rootTraceId: run.rootTraceId ?? null,
    allMessages: run.allMessages,
    resolvedTools: run.resolvedTools,
    toolsAuthority: run.toolsAuthority,
    model: run.model,
    typedAgent: run.typedAgent,
    agentId: run.agentId,
    result: end,
    toolContext: run.toolContext ?? null,
    remainingDepth: run.remainingDepth ?? null,
    provenance: run.provenance,
    replayed: run.replayed,
  });
};

const fireStreamEnd = (args: {
  run: StreamRunArgs;
  end: StreamEnd;
  cited: { content: string; turn: TurnCitations | null };
  failed: boolean;
}): void => {
  const { run, end } = args;
  fireStreamEndSideEffects({
    generationId: run.generationId,
    traceId: run.traceId,
    parentTraceId: run.parentTraceId ?? null,
    rootTraceId: run.rootTraceId ?? null,
    agentId: run.agentId,
    typedAgent: run.typedAgent,
    model: run.model,
    resolvedTools: run.resolvedTools,
    steps: end.steps,
    finalText: end.text,
    cited: args.cited,
    finishReason: end.finishReason,
    usage: end.usage,
    reportedModelId: end.response.modelId,
    failed: args.failed,
  });
};

// What the stream's completed calls spent, for the failure path to meter.
const carryStreamEndSpend = (args: { error: unknown; end: StreamEnd }) => {
  return carrySpentUsage({
    error: args.error,
    usage: args.end.usage,
    reportedModelId: args.end.response.modelId,
  });
};

/** What the stream learns while it runs, read once it ends. */
type StreamState = {
  streamError?: unknown;
  terminalGeneration?: GenerationResult;
  citations: TurnCitations | null;
};

/**
 * Settles a stream that ended: a pause on client calls, else the completed (or
 * failed) turn. Awaited by `streamText` before the text stream closes, so the
 * record exists before the caller reads the frame announcing it.
 */
const endStream = async (args: {
  run: StreamRunArgs;
  state: StreamState;
  end: StreamEnd;
}): Promise<void> => {
  const { run, state, end } = args;
  if (state.streamError === undefined) {
    try {
      state.terminalGeneration =
        (await settleStreamedClientCalls({ run, end })) ?? undefined;
    } catch (error) {
      // The settle owns this turn's records; `recordFailure` writes the
      // terminal status, and meters the calls the turn already made.
      state.streamError = carryStreamEndSpend({ error, end });
      return;
    }
    if (state.terminalGeneration) return;
  }
  const failed = state.streamError !== undefined;
  const cited = failed
    ? { content: end.text, turn: null }
    : await resolveTurnCitations({
        generationId: run.generationId,
        text: end.text,
      });
  state.citations = cited.turn;
  fireStreamEnd({ run, end, cited, failed });
};

export const runStreamGeneration = async (
  args: StreamRunArgs
): Promise<ReadableStream<StreamedGenerationPart>> => {
  const system = collectSystemInstructions(args.allMessages);
  const nonSystemMessages = withoutSystemMessages(args.allMessages);
  const prepareStep = buildPrepareStep({
    stepRules: args.typedAgent.stepRules,
    logContext: 'stream',
    toolIdToName: await resolveAgentStepRuleToolIdToName(args.typedAgent),
    promptCaching: args.typedAgent.promptCaching,
    answerStep: resolveAnswerStep(args.typedAgent),
    provenance: args.provenance,
  });
  const toolCount = Object.keys(args.resolvedTools).length;
  log('runStreamGeneration: agentId=%s toolCount=%d', args.agentId, toolCount);
  // Captured, not acted on: `onError` fires mid-read, and the failure must not
  // overtake chunks already on their way to the caller.
  const state: StreamState = { citations: null };
  const result = streamText({
    model: args.model,
    // Routed models own every attempt themselves (see `routedMaxRetries`).
    maxRetries: routedMaxRetries(args.model),
    instructions: system,
    messages: nonSystemMessages as ModelMessage[],
    toolChoice: args.toolChoice,
    prepareStep,
    stopWhen: resolveStopWhen(args.typedAgent),
    ...modelCallSettings(args.typedAgent),
    ...segmentCallOptions({
      generationId: args.generationId,
      steps: { target: turnStepTarget(args), firstIndex: 0 },
      tools: args.resolvedTools,
      signal: args.abortSignal,
    }),
    onError: ({ error }) => {
      state.streamError = error;
    },
    onEnd: (event) => {
      return endStream({
        run: args,
        state,
        end: {
          steps: event.steps as unknown[],
          text: event.text,
          finishReason: event.finishReason,
          usage: event.usage,
          response: event.response,
          responseMessages: event.responseMessages,
        },
      });
    },
  });
  return withTerminalError({
    source: args.citesSources
      ? result.textStream.pipeThrough(citationMarkupStripStream())
      : result.textStream,
    readStreamError: () => {
      return state.streamError;
    },
    readTerminalGeneration: () => {
      return state.terminalGeneration;
    },
    readCitations: () => {
      return state.citations;
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
