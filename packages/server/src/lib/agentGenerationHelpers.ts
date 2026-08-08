/* eslint-disable max-lines */
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  Tool,
  ToolChoice,
} from 'ai';
import { isStepCount, streamText } from 'ai';
import createDebug from 'debug';

import { resolveToolIdsToNames } from './agents';
import { emitResourceEvent } from './eventBus';
import { updateGenerationRecord } from './generations';
import { routedMaxRetries } from './modelRouteExecutor';
import { saveRoutingMetadata } from './modelRouteMetadata';
import { isPlainObject } from './outputSchema';
import { buildGenerationErrorPayload } from './providerError';
import {
  assertNoTextEncodedToolCall,
  findTextEncodedToolCall,
  textEncodedToolCallError,
} from './textEncodedToolCall';
import { recordTraceError, saveTrace, serializeSteps } from './traces';
import { recordGenerationUsage } from './usage';

const log = createDebug('soat:generation');

// ── Types ─────────────────────────────────────────────────────────────────

export type PendingGeneration = {
  agentId: string;
  projectId: number;
  projectPublicId: string;
  traceId: string;
  parentTraceId: string | null;
  rootTraceId: string | null;
  generationId: string;
  initiatorGenerationId: string | null;
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  // Tool results the guardrail gate synthesized for client calls it did NOT
  // release (class D / tripwire / pending_approval). They belong to the same
  // assistant turn as `pendingToolCalls`, so they must be injected alongside the
  // client-submitted outputs when the loop resumes — otherwise the provider sees
  // a tool call with no result. Absent/empty for a generation with no gated
  // client calls.
  syntheticToolResults?: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
  }>;
  messages: Array<unknown>;
  steps: unknown[];
  resolvedModel: LanguageModel;
  agentConfig: {
    instructions: string | null;
    maxSteps: number;
    toolChoice: unknown;
    stopConditions: unknown;
    activeToolIds: string[] | null;
    stepRules: unknown;
    temperature: number | null;
    outputSchema: unknown;
  };
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string>;
};

export type GenerationResult = {
  id: string;
  traceId: string;
  status: 'completed' | 'requires_action';
  output?: {
    model: string;
    content: string;
    finishReason: string;
    /** Full AI SDK response messages from this generation (tool calls, tool results, final text). */
    responseMessages?: Array<unknown>;
    /** Structured object matching the agent's `outputSchema`, when configured. */
    object?: unknown;
  };
  requiredAction?: {
    type: 'submit_tool_outputs';
    toolCalls: Array<{
      id: string;
      toolName: string;
      args: unknown;
    }>;
  };
};

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

export type TypedAgent = {
  instructions: string | null;
  model: string | null;
  toolBindings?: unknown;
  toolIds: unknown;
  tools: unknown;
  maxSteps: unknown;
  toolChoice: unknown;
  stopConditions: unknown;
  activeToolIds: unknown;
  stepRules: unknown;
  boundaryPolicy: unknown;
  temperature: unknown;
  knowledgeConfig: unknown;
  outputSchema: unknown;
  guardrailIds?: string[] | null;
  /**
   * Internal row id of the live agent. Present on a row loaded from the DB;
   * absent on a config rebuilt from an archived version. Used to look up the
   * archive a staged rollout assigns (`agentServedVersion.ts`).
   */
  id?: number;
  /** Config version this agent is serving. */
  version?: number;
  /** Staged rollout pointer, read by the served-version resolver. */
  activeRelease?: unknown;
  project: { id: unknown; publicId: string; guardrailIds?: string[] | null };
  // Exactly one of these is set (enforced on every agent write path by
  // `validateModelRouteExclusivity`): a pinned provider, or a model route whose
  // ordered targets resolve the completion model with failover.
  aiProvider: { publicId: string } | null;
  modelRoute?: { publicId: string } | null;
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

// ── Tool Choice ───────────────────────────────────────────────────────────

// `tool_choice` (agent-level and inside `step_rules`) is stored verbatim from
// the request body, so the object form arrives wire-shaped:
// { type: "tool", tool_name: "..." }. The AI SDK expects
// { type: "tool", toolName: "..." } — this is the single translation point.
// The legacy camelCase key is still accepted for agents stored before the
// wire shape worked.
export const normalizeToolChoice = (
  value: unknown
):
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'tool'; toolName: string }
  | undefined => {
  if (value === 'auto' || value === 'required' || value === 'none') {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as {
      type?: unknown;
      tool_name?: unknown;
      toolName?: unknown;
    };
    if (record.type === 'tool') {
      const toolName =
        typeof record.tool_name === 'string'
          ? record.tool_name
          : typeof record.toolName === 'string'
            ? record.toolName
            : undefined;
      if (toolName) {
        return { type: 'tool', toolName };
      }
    }
  }
  return undefined;
};

// ── Step Rules ────────────────────────────────────────────────────────────

type StepRule = {
  step: number;
  tool_choice?: unknown;
  toolChoice?: unknown;
  active_tool_ids?: unknown;
  activeToolIds?: unknown;
};

/**
 * Every tool id named by any rule's `active_tool_ids`, deduped. This is the
 * set `resolveToolIdsToNames` (`agents.ts`) needs resolved to names before
 * `buildPrepareStep` can honor a step-level restriction — the AI SDK's
 * `activeTools` option is keyed by tool name, the persisted rule holds tool
 * ids (`modules/agents.md` — Step Rules, #809).
 */
export const collectStepRuleActiveToolIds = (stepRules: unknown): string[] => {
  if (!Array.isArray(stepRules)) return [];
  const ids = new Set<string>();
  for (const rule of stepRules as StepRule[]) {
    const ruleIds = rule?.active_tool_ids ?? rule?.activeToolIds;
    if (!Array.isArray(ruleIds)) continue;
    for (const id of ruleIds) {
      if (typeof id === 'string') ids.add(id);
    }
  }
  return [...ids];
};

/**
 * Translates a single rule's `active_tool_ids` (tool ids) into the tool names
 * `activeTools` expects, via the id→name map `collectStepRuleActiveToolIds` +
 * `resolveToolIdsToNames` produced. Returns `undefined` — "no restriction from
 * this rule" — when the field is absent/empty/not-an-array, or when every id
 * fails to resolve (mirrors `narrowToActiveTools`'s fail-open stance: an
 * unresolvable restriction is never read as "make no tools active").
 */
export const resolveStepActiveTools = (args: {
  activeToolIds: unknown;
  toolIdToName: Record<string, string>;
}): string[] | undefined => {
  if (!Array.isArray(args.activeToolIds) || args.activeToolIds.length === 0) {
    return undefined;
  }
  const names = args.activeToolIds
    .filter((id): id is string => {
      return typeof id === 'string';
    })
    .map((id) => {
      return args.toolIdToName[id];
    })
    .filter((name): name is string => {
      return typeof name === 'string';
    });
  return names.length > 0 ? names : undefined;
};

/**
 * Combines a rule's normalized `tool_choice` and resolved `active_tool_ids`
 * into the shape `prepareStep` returns. Split out of `buildPrepareStep`'s
 * closure so each closure body stays a thin log-and-delegate wrapper — the
 * `tool_choice`-shape branching lives here once instead of duplicated (and
 * counted) in both the stream and non-stream copies.
 */
export const resolvePrepareStepResult = (args: {
  ruleToolChoice: ReturnType<typeof normalizeToolChoice>;
  ruleActiveTools: string[] | undefined;
}): {
  toolChoice?: ToolChoice<Record<string, Tool>>;
  activeTools?: string[];
} => {
  const { ruleToolChoice, ruleActiveTools } = args;
  if (ruleToolChoice === undefined) {
    return ruleActiveTools ? { activeTools: ruleActiveTools } : {};
  }
  if (typeof ruleToolChoice === 'object' && ruleToolChoice.type === 'tool') {
    return {
      toolChoice: ruleToolChoice,
      activeTools: ruleActiveTools ?? [ruleToolChoice.toolName],
    };
  }
  // A string choice ('auto' | 'required' | 'none') overrides the agent's own
  // tool_choice for this step; no tool is named, so the active tool set is
  // only narrowed if the rule also sets active_tool_ids.
  return ruleActiveTools
    ? { toolChoice: ruleToolChoice, activeTools: ruleActiveTools }
    : { toolChoice: ruleToolChoice };
};

/**
 * Resolves the id→name map `buildPrepareStep` needs for a `TypedAgent`'s
 * `step_rules[].active_tool_ids`, skipping the DB round trip when no rule
 * names any tool id.
 */
export const resolveStepRuleToolIdToName = async (
  typedAgent: TypedAgent
): Promise<Record<string, string>> => {
  const stepRuleToolIds = collectStepRuleActiveToolIds(typedAgent.stepRules);
  if (stepRuleToolIds.length === 0) return {};
  return resolveToolIdsToNames({
    toolIds: stepRuleToolIds,
    projectId: typedAgent.project.id as number,
  });
};

const buildPrepareStep = (
  stepRules: unknown,
  toolIdToName: Record<string, string> = {}
):
  | ((opts: { stepNumber: number }) => {
      toolChoice?: ToolChoice<Record<string, Tool>>;
      activeTools?: string[];
    })
  | undefined => {
  if (!Array.isArray(stepRules) || stepRules.length === 0) return undefined;
  const rules = stepRules as StepRule[];
  log('buildPrepareStep (stream): rules=%o', rules);
  return ({ stepNumber }) => {
    // stepNumber is 0-based (AI SDK), step_rules use 1-indexed steps
    const rule = rules.find((r) => {
      return r.step === stepNumber + 1;
    });
    log(
      'prepareStep (stream): stepNumber=%d (1-indexed=%d) rule=%o',
      stepNumber,
      stepNumber + 1,
      rule
    );
    const result = resolvePrepareStepResult({
      ruleToolChoice: normalizeToolChoice(
        rule?.tool_choice ?? rule?.toolChoice
      ),
      ruleActiveTools: resolveStepActiveTools({
        activeToolIds: rule?.active_tool_ids ?? rule?.activeToolIds,
        toolIdToName,
      }),
    });
    log('prepareStep (stream): result=%o', result);
    return result;
  };
};

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
  const system = args.allMessages.find((m) => {
    return m.role === 'system';
  })?.content as string | undefined;
  const nonSystemMessages = args.allMessages.filter((m) => {
    return m.role !== 'system';
  });
  const toolIdToName = await resolveStepRuleToolIdToName(args.typedAgent);
  const prepareStep = buildPrepareStep(args.typedAgent.stepRules, toolIdToName);
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

export const findPendingClientTools = (
  steps: Array<{
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  }>,
  resolvedTools: Record<string, Tool>
): Array<{ toolCallId: string; toolName: string; input: unknown }> => {
  return steps
    .flatMap((step) => {
      return step.toolCalls ?? [];
    })
    .filter((tc) => {
      const resolvedTool = resolvedTools[tc.toolName];
      return resolvedTool && !('execute' in resolvedTool);
    });
};

type SyntheticToolResult = {
  toolCallId: string;
  toolName: string;
  output: unknown;
};

const storePendingGenerationState = (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  agentId: string;
  typedAgent: TypedAgent;
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  syntheticToolResults?: SyntheticToolResult[];
  allMessages: Array<{ role: string; content: unknown }>;
  result: { steps: unknown[]; response: { messages: unknown[] } };
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): void => {
  const syntheticToolResults = args.syntheticToolResults ?? [];
  pendingGenerations.set(args.generationId, {
    agentId: args.agentId,
    projectId: args.typedAgent.project.id as number,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    generationId: args.generationId,
    pendingToolCalls: args.pendingToolCalls.map((tc) => {
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      };
    }),
    syntheticToolResults,
    messages: [...args.allMessages, ...args.result.response.messages],
    steps: serializeSteps(args.result.steps),
    resolvedModel: args.model,
    agentConfig: {
      instructions: args.typedAgent.instructions,
      maxSteps: (args.typedAgent.maxSteps as number) ?? 20,
      toolChoice: args.typedAgent.toolChoice,
      stopConditions: args.typedAgent.stopConditions,
      activeToolIds: args.typedAgent.activeToolIds as string[] | null,
      stepRules: args.typedAgent.stepRules,
      temperature: args.typedAgent.temperature as number | null,
      outputSchema: args.typedAgent.outputSchema,
    },
    resolvedTools: args.resolvedTools,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
  });

  // Persist pending state to DB so it can be recovered after a server restart.
  const pendingState: Record<string, unknown> = {
    pendingToolCalls: args.pendingToolCalls.map((tc) => {
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      };
    }),
    syntheticToolResults,
    messages: [...args.allMessages, ...args.result.response.messages],
    steps: serializeSteps(args.result.steps),
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
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  syntheticToolResults?: SyntheticToolResult[];
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
