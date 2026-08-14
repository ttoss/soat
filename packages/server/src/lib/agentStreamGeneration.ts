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
  normalizeToolChoice,
  resolveAgentStepRuleToolIdToName,
} from './agentStepRules';
import { updateGenerationRecord } from './generations';
import {
  collectSystemInstructions,
  withoutSystemMessages,
} from './modelMessages';
import { routedMaxRetries } from './modelRouteExecutor';
import { saveRoutingMetadata } from './modelRouteMetadata';
import { isPlainObject } from './plainObject';
import { buildGenerationErrorPayload } from './providerError';
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
}): void => {
  saveTrace({
    traceId: args.traceId,
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    agentId: args.agentId,
    steps: serializeSteps(args.steps),
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
  }).catch(() => {});

  // The blob has already gone down the wire — a stream cannot be recalled —
  // but the record of it can still tell the truth. Recording `failed` is what
  // makes this findable on the generation and the trace instead of only in
  // whatever consumed the stream. (`output_schema` never reaches here:
  // streaming rejects it upfront.)
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
  } else {
    updateGenerationRecord({
      publicId: args.generationId,
      status: 'completed',
      completedAt: new Date(),
      stopReason: args.finishReason,
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

export const runStreamGeneration = async (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
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
    toolChoice: normalizeToolChoice(args.typedAgent.toolChoice),
    prepareStep,
    stopWhen: isStepCount((args.typedAgent.maxSteps as number) ?? 20),
    temperature: (args.typedAgent.temperature as number) ?? undefined,
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
      });
    },
  });
  return result.textStream as unknown as ReadableStream;
};
