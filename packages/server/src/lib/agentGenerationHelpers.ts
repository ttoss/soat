import type { LanguageModel, LanguageModelUsage, Tool } from 'ai';

import {
  type ClientToolCall,
  type ClientToolResult,
  type GenerationResult,
  type PendingGeneration,
  toAgentConfig,
  type TypedAgent,
} from './agentGenerationTypes';
import { emitResourceEvent } from './eventBus';
import { updateGenerationRecord } from './generations';
import { saveRoutingMetadata } from './modelRouteMetadata';
import { assertNoTextEncodedToolCall } from './textEncodedToolCall';
import { saveTrace, serializeSteps } from './traces';
import { recordGenerationUsage } from './usage';

// ── Wire Mappers ──────────────────────────────────────────────────────────

/**
 * The wire projection of a `GenerationResult`, matching the generate response
 * schema in `openapi/v1/agents.yaml`. The type itself stays camelCase because it
 * is threaded through the session, conversation, and orchestration paths
 * internally; only the routes that put it on the wire map it.
 *
 * `object` and each `args` are caller-owned payloads (a structured output shaped
 * by the agent's `output_schema`, and the model's tool arguments), so they are
 * copied as values — their inner keys are never inspected. Same for
 * `response_messages`, which is the AI SDK's own message format.
 */
/** Wire projection of a generation's pending client tool calls. */
export const mapGenerationRequiredAction = (
  action: NonNullable<GenerationResult['requiredAction']>
) => {
  return {
    type: action.type,
    tool_calls: action.toolCalls.map((call) => {
      return {
        id: call.id,
        tool_name: call.toolName,
        // The model's own arguments — copied as a value, keys untouched.
        args: call.args,
      };
    }),
  };
};

export const mapGenerationResult = (result: GenerationResult) => {
  return {
    id: result.id,
    trace_id: result.traceId,
    status: result.status,
    ...(result.output
      ? {
          output: {
            model: result.output.model,
            content: result.output.content,
            finish_reason: result.output.finishReason,
            ...(result.output.responseMessages
              ? { response_messages: result.output.responseMessages }
              : {}),
            ...('object' in result.output
              ? { object: result.output.object }
              : {}),
          },
        }
      : {}),
    ...(result.requiredAction
      ? { required_action: mapGenerationRequiredAction(result.requiredAction) }
      : {}),
  };
};

// ── In-Memory Store ───────────────────────────────────────────────────────

export const pendingGenerations = new Map<string, PendingGeneration>();

export const buildAllMessages = (
  instructions: string | null,
  messages: Array<{ role: string; content: unknown }>
): Array<{ role: string; content: unknown }> => {
  if (!instructions) return messages;
  return [{ role: 'system', content: instructions }, ...messages];
};

export const findPendingClientTools = (
  steps: Array<{ toolCalls?: ClientToolCall[] }>,
  resolvedTools: Record<string, Tool>
): ClientToolCall[] => {
  return steps
    .flatMap((step) => {
      return step.toolCalls ?? [];
    })
    .filter((tc) => {
      const resolvedTool = resolvedTools[tc.toolName];
      return resolvedTool && !('execute' in resolvedTool);
    });
};

/** The pending calls in the shape both the in-memory and persisted state hold. */
const toPendingToolCalls = (
  calls: ClientToolCall[]
): PendingGeneration['pendingToolCalls'] => {
  return calls.map((tc) => {
    return { toolCallId: tc.toolCallId, toolName: tc.toolName, args: tc.input };
  });
};

const storePendingGenerationState = (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  agentId: string;
  typedAgent: TypedAgent;
  pendingToolCalls: ClientToolCall[];
  syntheticToolResults?: ClientToolResult[];
  allMessages: Array<{ role: string; content: unknown }>;
  result: { steps: unknown[]; response: { messages: unknown[] } };
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): void => {
  // The in-memory copy and the persisted one carry the same turn. Each piece is
  // computed once here rather than twice below, so a change to how a turn is
  // frozen cannot land on only one of them — a recovered generation would then
  // resume from a different history than a live one.
  const syntheticToolResults = args.syntheticToolResults ?? [];
  const pendingToolCalls = toPendingToolCalls(args.pendingToolCalls);
  const messages = [...args.allMessages, ...args.result.response.messages];
  const steps = serializeSteps(args.result.steps);

  pendingGenerations.set(args.generationId, {
    agentId: args.agentId,
    projectId: args.typedAgent.project.id as number,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    generationId: args.generationId,
    pendingToolCalls,
    syntheticToolResults,
    messages,
    steps,
    resolvedModel: args.model,
    agentConfig: toAgentConfig(args.typedAgent),
    resolvedTools: args.resolvedTools,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
  });

  // Persist pending state to DB so it can be recovered after a server restart.
  const pendingState: Record<string, unknown> = {
    pendingToolCalls,
    syntheticToolResults,
    messages,
    steps,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    toolContext: args.toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
  };
  // Writes `pendingState`'s own column. This used to be
  // `metadata: { pendingState }` — a full replace of the bag that also held
  // usage attribution, so every generation that paused for a client tool lost
  // its action/trigger/run/node attribution and all caller metadata, and its
  // usage event was recorded unattributed.
  updateGenerationRecord({
    publicId: args.generationId,
    pendingState,
  }).catch(() => {});
};

export const savePendingGeneration = (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  pendingToolCalls: ClientToolCall[];
  syntheticToolResults?: ClientToolResult[];
  allMessages: Array<{ role: string; content: unknown }>;
  result: { steps: unknown[]; response: { messages: unknown[] } };
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): GenerationResult => {
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'requires_action',
    lastActivityAt: new Date(),
  }).catch(() => {});

  storePendingGenerationState(args);

  const requiresActionResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'requires_action',
    requiredAction: {
      type: 'submit_tool_outputs',
      toolCalls: args.pendingToolCalls.map((tc) => {
        return {
          id: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.input,
        };
      }),
    },
  };

  emitResourceEvent({
    type: 'agents.generation.requires_action',
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    resourceType: 'generation',
    resourceId: args.generationId,
    data: requiresActionResult,
  });

  return requiresActionResult;
};

export const buildCompletedGenerationResult = async (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  result: {
    steps: unknown[];
    response?: { modelId?: string; messages?: Array<unknown> };
    text: string;
    finishReason: string;
    object?: unknown;
    usage?: LanguageModelUsage;
  };
  typedAgent: TypedAgent;
  agentId: string;
  /** The model the turn ran on — routed models stamp the `routing` column. */
  model?: LanguageModel;
  /** Names of the tools bound to this turn, for the text-encoded-call guard. */
  toolNames?: string[];
}): Promise<GenerationResult> => {
  await saveRoutingMetadata({
    generationId: args.generationId,
    model: args.model,
  });
  const serializedStepsCompleted = serializeSteps(
    args.result.steps as unknown[]
  );
  await saveTrace({
    traceId: args.traceId,
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    agentId: args.agentId,
    generationId: args.generationId,
    steps: serializedStepsCompleted,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  });
  // After the trace is written and before the generation is marked completed:
  // the offending text is the whole evidence for this failure, so it must be
  // on the trace, and a generation that throws here must never have been
  // recorded `completed`. The caller's `recordGenerationFailure` stamps the
  // failure onto both records from here.
  assertNoTextEncodedToolCall({
    text: args.result.text,
    toolNames: args.toolNames ?? [],
    outputSchema: args.typedAgent.outputSchema,
    generationId: args.generationId,
  });
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'completed',
    completedAt: new Date(),
    stopReason: args.result.finishReason,
  }).catch(() => {});

  const model = args.result.response?.modelId ?? args.typedAgent.model ?? '';

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: {
      model,
      content: args.result.text,
      finishReason: args.result.finishReason,
      responseMessages: args.result.response?.messages,
      ...(args.result.object !== undefined
        ? { object: args.result.object }
        : {}),
    },
  };

  await recordGenerationUsage({
    generationId: args.generationId,
    model,
    usage: args.result.usage,
  });

  emitResourceEvent({
    type: 'agents.generation.completed',
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    resourceType: 'generation',
    resourceId: args.generationId,
    data: completedResult,
  });

  return completedResult;
};
