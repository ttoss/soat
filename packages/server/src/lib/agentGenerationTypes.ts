/**
 * The types the agent-generation cluster is built from, and the round trip
 * between an agent's config and the snapshot a paused generation carries.
 *
 * This module is a **leaf**: it imports nothing from the cluster. Five of the
 * six import cycles #910 found formed because a type lived next to one of its
 * implementations, and the agent cluster had grown the same three (#911) — a
 * module that needed `TypedAgent` had to import the 800-line helper file that
 * happened to declare it. Keeping the vocabulary here is what lets
 * `agentStepRules`, `agentToolSurface` and `agentModelResolution` be leaves too.
 */
import type { LanguageModel, LanguageModelUsage, Tool } from 'ai';

/**
 * A client tool call the model proposed but the server did not execute — either
 * still pending, or released to the client by the guardrail gate. `input` is the
 * model's own arguments, copied as an opaque value.
 */
export type ClientToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/**
 * A tool result synthesized for a client call the gate did NOT release
 * (class D / tripwire / pending_approval).
 */
export type ClientToolResult = {
  toolCallId: string;
  toolName: string;
  output: unknown;
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

/**
 * The slice of an agent's config a paused generation freezes, so the turn that
 * resumes it runs against the config it started on rather than whatever the
 * agent has been edited into since. Built and read back by {@link toAgentConfig}
 * and {@link fromAgentConfig} — never spelled out again at a call site.
 */
export type PendingAgentConfig = {
  instructions: string | null;
  maxSteps: number;
  toolChoice: unknown;
  stopConditions: unknown;
  activeToolIds: string[] | null;
  stepRules: unknown;
  temperature: number | null;
  outputSchema: unknown;
};

/** The AI SDK's default step budget, applied when the agent names none. */
const DEFAULT_MAX_STEPS = 20;

/**
 * Freezes an agent's config for a generation that is about to pause. This
 * literal used to be copy-pasted at three suspend points and read back at a
 * fourth; a field added to one copy and not the others would have silently
 * changed behavior between "paused on the initial turn" and "paused on a
 * continuation".
 */
export const toAgentConfig = (typedAgent: TypedAgent): PendingAgentConfig => {
  return {
    instructions: typedAgent.instructions,
    maxSteps: (typedAgent.maxSteps as number) ?? DEFAULT_MAX_STEPS,
    toolChoice: typedAgent.toolChoice,
    stopConditions: typedAgent.stopConditions,
    activeToolIds: typedAgent.activeToolIds as string[] | null,
    stepRules: typedAgent.stepRules,
    temperature: typedAgent.temperature as number | null,
    outputSchema: typedAgent.outputSchema,
  };
};

/**
 * The inverse of {@link toAgentConfig}: the `TypedAgent` view a continuation
 * turn runs against. The model and tool surface are already resolved on the
 * pending state, so the binding fields a fresh generation would resolve from
 * are deliberately empty here.
 */
export const fromAgentConfig = (pending: PendingGeneration): TypedAgent => {
  return {
    instructions: pending.agentConfig.instructions,
    model: null,
    toolIds: null,
    tools: null,
    maxSteps: pending.agentConfig.maxSteps,
    toolChoice: pending.agentConfig.toolChoice,
    stopConditions: pending.agentConfig.stopConditions,
    activeToolIds: pending.agentConfig.activeToolIds,
    stepRules: pending.agentConfig.stepRules,
    boundaryPolicy: null,
    temperature: pending.agentConfig.temperature,
    knowledgeConfig: null,
    outputSchema: pending.agentConfig.outputSchema,
    project: { id: pending.projectId, publicId: pending.projectPublicId },
    aiProvider: { publicId: '' },
  };
};

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
  syntheticToolResults?: ClientToolResult[];
  messages: Array<unknown>;
  steps: unknown[];
  resolvedModel: LanguageModel;
  agentConfig: PendingAgentConfig;
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
 * What a `generateText` turn returns, narrowed to the fields this cluster reads.
 * The initial turn and a tool-outputs continuation declared byte-identical
 * copies of this under two names; they are the same turn shape, so they are the
 * same type.
 */
export type AgentRunResult = {
  steps: unknown[];
  response?: { messages?: unknown[]; modelId?: string };
  text: string;
  finishReason: string;
  output?: unknown;
  usage?: LanguageModelUsage;
};
