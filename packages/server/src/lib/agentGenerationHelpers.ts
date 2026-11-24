import type { LanguageModel, LanguageModelUsage, Tool } from 'ai';

import {
  type ClientToolCall,
  type ClientToolResult,
  type GenerationResult,
  type PendingGeneration,
  toAgentConfig,
  type TypedAgent,
} from './agentGenerationTypes';
import type { GenerationRequiredActionWire } from './generationEvents';
import { recordSegmentUsage } from './generationLifecycle';
import type { GenerationProvenance } from './generationProvenance';
import { logSettleFailure, settleGeneration } from './generationSettle';
import { resolveStopReason } from './generationStopReason';
import { routedAiProviderId, servedModelName } from './modelRouteExecutor';
import { saveRoutingMetadata } from './modelRouteMetadata';
import type { ReplayedWindow } from './replayRefusal';
import { assertNoTextEncodedToolCall } from './textEncodedToolCall';
import {
  mergePresetParameters,
  readClientToolPresets,
} from './toolPresetParameters';
import { splitVendorOptions } from './vendorOptions';
import type { WorkAuthority } from './workAuthority';

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
    // Always present, never omitted on a null: a consumer translating
    // `output.model` reads provenance off one field, and an absent key would
    // be indistinguishable from an older server that never sent it.
    ai_provider_id: result.aiProviderId ?? null,
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

/**
 * The client tool calls a turn proposed, with each tool's `preset_parameters`
 * pinned over the model's arguments.
 *
 * This is where a client tool's presets are applied: it has no server-side
 * `execute` to merge into, so the resolver hangs them off the tool (under
 * `CLIENT_TOOL_PRESETS`, see `toolPresetParameters.ts`) and the pin lands here —
 * on the arguments that go to the guardrail gate, the stored pending state, and
 * the client at the `requires_action` boundary.
 */
export const findPendingClientTools = (
  steps: Array<{ toolCalls: ClientToolCall[] }>,
  resolvedTools: Record<string, Tool>
): ClientToolCall[] => {
  return steps
    .flatMap((step) => {
      return step.toolCalls;
    })
    .filter((tc) => {
      const resolvedTool = resolvedTools[tc.toolName];
      return resolvedTool && !('execute' in resolvedTool);
    })
    .map((tc) => {
      const presetParameters = readClientToolPresets(
        resolvedTools[tc.toolName]
      );
      if (!presetParameters) return tc;
      return {
        ...tc,
        input: mergePresetParameters({ presetParameters, input: tc.input }),
      };
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
  result: { steps: unknown[]; responseMessages: unknown[] };
  /** Steps this turn spent before the segment `result` describes. */
  priorStepCount?: number;
  /** Trailing `allMessages` this turn produced before `result`. */
  priorTurnMessageCount?: number;
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  toolsAuthority: WorkAuthority | null;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
  aiProviderId: string | null;
  provenance: GenerationProvenance;
  replayed: ReplayedWindow | null;
  requiredAction: GenerationRequiredActionWire;
}): Promise<unknown> => {
  // Computed once rather than twice below, so a change to how a turn is frozen
  // cannot land on only one copy and leave a recovered generation resuming from
  // a different history than a live one.
  const syntheticToolResults = args.syntheticToolResults ?? [];
  const pendingToolCalls = toPendingToolCalls(args.pendingToolCalls);
  const messages = [...args.allMessages, ...args.result.responseMessages];
  const turnMessageCount =
    (args.priorTurnMessageCount ?? 0) + args.result.responseMessages.length;
  // The whole turn's count, not the last segment's: a turn can pause more than
  // once, and its step budget and step indices run across all of them.
  const stepCount = (args.priorStepCount ?? 0) + args.result.steps.length;

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
    turnMessageCount,
    stepCount,
    resolvedModel: args.model,
    aiProviderId: args.aiProviderId,
    agentConfig: toAgentConfig(args.typedAgent),
    resolvedTools: args.resolvedTools,
    toolsAuthority: args.toolsAuthority,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
    provenance: args.provenance,
    replayed: args.replayed,
  });

  // Persist pending state to DB so it can be recovered after a server restart.
  const pendingState: Record<string, unknown> = {
    pendingToolCalls,
    syntheticToolResults,
    messages,
    turnMessageCount,
    stepCount,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    toolContext: args.toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
    replayed: args.replayed,
  };
  // Its own column: `metadata` is the caller's bag. Awaited: a submission
  // claims the pause by its status, so it must land before the caller can
  // answer.
  return settleGeneration({
    generationId: args.generationId,
    fence: 'lease',
    outcome: {
      status: 'requires_action',
      pendingState,
      requiredAction: args.requiredAction,
    },
  });
};

/**
 * The provider that served the turn: the target a route picked where one ran,
 * the agent's pinned provider otherwise. A routed agent has no pin, so the two
 * cases never compete.
 */
export const servedAiProviderId = (args: {
  model: LanguageModel;
  typedAgent: TypedAgent;
}): string | null => {
  return (
    routedAiProviderId(args.model) ??
    args.typedAgent.aiProvider?.publicId ??
    null
  );
};

export const savePendingGeneration = async (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  pendingToolCalls: ClientToolCall[];
  syntheticToolResults?: ClientToolResult[];
  allMessages: Array<{ role: string; content: unknown }>;
  result: { steps: unknown[]; responseMessages: unknown[] };
  priorStepCount?: number;
  priorTurnMessageCount?: number;
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  resolvedTools: Record<string, Tool>;
  toolsAuthority: WorkAuthority | null;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
  provenance: GenerationProvenance;
  /** The conversation positions the turn replays; `null` when it replays none. */
  replayed: ReplayedWindow | null;
}): Promise<GenerationResult> => {
  const aiProviderId = servedAiProviderId({
    model: args.model,
    typedAgent: args.typedAgent,
  });

  const requiredAction: NonNullable<GenerationResult['requiredAction']> = {
    type: 'submit_tool_outputs',
    toolCalls: args.pendingToolCalls.map((tc) => {
      return {
        id: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      };
    }),
  };
  const requiresActionResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'requires_action',
    aiProviderId,
    requiredAction,
  };

  await storePendingGenerationState({
    ...args,
    aiProviderId,
    requiredAction: mapGenerationRequiredAction(requiredAction),
  });

  return requiresActionResult;
};

// A turn that completed in one `generateText` call is one metered segment.
const meterCompletedTurn = (args: {
  generationId: string;
  reportedModelId: string | undefined;
  model: LanguageModel;
  typedAgent: TypedAgent;
  result: {
    steps: unknown[];
    finishReason: string;
    usage?: LanguageModelUsage;
  };
}): Promise<void> => {
  return recordSegmentUsage({
    generationId: args.generationId,
    model: args.model,
    reportedModelId: args.reportedModelId,
    usage: args.result.usage,
    stepsAlreadySpent: 0,
    turn: {
      steps: args.result.steps,
      finishReason: args.result.finishReason,
      budget: args.typedAgent,
      outcome: 'ok',
    },
  });
};

/** A completed turn's messages, in the shape a caller is served. */
export const servedTurnMessages = (messages: unknown[]) => {
  const split = splitVendorOptions({ messages });
  return {
    responseMessages: split.messages,
    vendorOptions: split.vendorOptions,
  };
};

export const buildCompletedGenerationResult = async (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  result: {
    steps: unknown[];
    response: { modelId: string };
    responseMessages: unknown[];
    text: string;
    finishReason: string;
    object?: unknown;
    usage?: LanguageModelUsage;
  };
  typedAgent: TypedAgent;
  agentId: string;
  /** The model the turn ran on — routed models stamp the `routing` column. */
  model: LanguageModel;
  /** Names of the tools bound to this turn, for the text-encoded-call guard. */
  toolNames: string[];
}): Promise<GenerationResult> => {
  await saveRoutingMetadata({
    generationId: args.generationId,
    model: args.model,
  });
  // The steps, the offending text with them, were recorded as they ended;
  // before the generation is marked completed, which a generation throwing
  // here must never have been.
  assertNoTextEncodedToolCall({
    text: args.result.text,
    toolNames: args.toolNames,
    outputSchema: args.typedAgent.outputSchema,
    generationId: args.generationId,
  });
  const reportedModelId = args.result.response.modelId;
  const model = servedModelName({ model: args.model, reportedModelId });

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    aiProviderId: servedAiProviderId(args),
    output: {
      model,
      content: args.result.text,
      finishReason: args.result.finishReason,
      ...servedTurnMessages(args.result.responseMessages),
      ...(args.result.object !== undefined
        ? { object: args.result.object }
        : {}),
    },
  };

  // A failed status write must not fail the generation, whose result is
  // already built.
  await settleGeneration({
    generationId: args.generationId,
    fence: 'lease',
    outcome: {
      status: 'completed',
      stopReason: resolveStopReason({
        finishReason: args.result.finishReason,
        stepCount: args.result.steps.length,
        budget: args.typedAgent,
      }),
      assistantContent: args.result.text,
    },
    effects: () => {
      return [meterCompletedTurn({ ...args, reportedModelId })];
    },
  }).catch(logSettleFailure(args.generationId));

  return completedResult;
};
