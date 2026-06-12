import type { JSONValue } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { updateGenerationRecord } from './generations';
import * as reasoningCompletion from './reasoningCompletion';

const log = createDebug('soat:reasoning');

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type ReasoningOverrideTriple = {
  aiProviderId?: string;
  model?: string;
  prompt?: string;
};

export type PerspectiveConfig = {
  name?: string;
  prompt?: string;
  aiProviderId?: string;
  model?: string;
};

export type ReasoningConfig = {
  /** Provider-native reasoning effort, forwarded to providers that support it. */
  effort?: ReasoningEffort;
  /** Orchestrated reasoning strategy. Defaults to none. */
  mode?: 'none' | 'reflect' | 'debate';
  /** Reflect only — overrides for the critique pass. */
  critique?: ReasoningOverrideTriple;
  /** Debate only — integer count (2–5) or explicit perspective objects. */
  perspectives?: number | PerspectiveConfig[];
  /** Debate only — rounds of perspective turns. Default 1, max 3. */
  maxRounds?: number;
  /** Debate only — override triple for the synthesis pass. */
  synthesis?: ReasoningOverrideTriple;
};

export type ReasoningMessage = { role: string; content: unknown };

/**
 * Resolves the effective reasoning config: the per-generate override replaces
 * the agent config entirely (object replace, not deep merge). Returns null
 * when reasoning is not configured or explicitly disabled.
 */
export const resolveReasoningConfig = (args: {
  agentConfig?: unknown;
  override?: unknown;
}): ReasoningConfig | null => {
  const candidate = args.override ?? args.agentConfig;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const config = candidate as ReasoningConfig;
  if (config.mode === 'none' && !config.effort) return null;
  if (!config.mode && !config.effort && !config.critique) return null;
  return config;
};

const EFFORT_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
};

export type ProviderOptionsMap = Record<string, Record<string, JSONValue>>;

export type ReasoningProviderOptions = {
  providerOptions: ProviderOptionsMap;
  /** Anthropic requires max_tokens to exceed the thinking budget. */
  maxOutputTokens?: number;
};

/**
 * Maps the normalized `effort` level to provider-native reasoning options.
 * Returns undefined for providers without a supported mapping — the effort
 * field is then a no-op rather than an error.
 */
export const buildReasoningProviderOptions = (args: {
  provider: string;
  effort?: ReasoningEffort;
}): ReasoningProviderOptions | undefined => {
  const budget = args.effort ? EFFORT_BUDGET_TOKENS[args.effort] : undefined;
  if (!args.effort || !budget) return undefined;

  if (args.provider === 'openai') {
    return { providerOptions: { openai: { reasoningEffort: args.effort } } };
  }
  if (args.provider === 'anthropic') {
    return {
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: budget } },
      },
      maxOutputTokens: budget + 8192,
    };
  }
  if (args.provider === 'google') {
    return {
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: budget } },
      },
    };
  }

  log(
    'buildReasoningProviderOptions: no mapping provider=%s effort=%s',
    args.provider,
    args.effort
  );
  return undefined;
};

/**
 * Resolves the effective reasoning config and provider-native options for a
 * generation context in one step.
 */
export const resolveReasoningForContext = (args: {
  typedAgent: { reasoningConfig: unknown };
  override?: object;
  provider: string;
}) => {
  const reasoningConfig = resolveReasoningConfig({
    agentConfig: args.typedAgent.reasoningConfig,
    override: args.override,
  });
  const reasoningOptions = buildReasoningProviderOptions({
    provider: args.provider,
    effort: reasoningConfig?.effort,
  });
  return { reasoningConfig, reasoningOptions };
};

const DEFAULT_CRITIQUE_INSTRUCTIONS = [
  'You are reviewing a draft answer. Identify factual errors, gaps, unsupported claims, and weaknesses in the reasoning.',
  'Be specific and concise.',
].join('\n');

const formatQuestion = (messages: ReasoningMessage[]): string => {
  return messages
    .filter((message) => {
      return (
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        (message.content as string).trim().length > 0
      );
    })
    .map((message) => {
      return `${message.role}: ${message.content as string}`;
    })
    .join('\n');
};

const buildCritiquePrompt = (args: {
  question: string;
  draft: string;
  instructions?: string;
}): string => {
  // A custom prompt replaces only the critique instructions; the
  // engine-owned scaffolding (question, draft, APPROVED contract) is kept.
  return [
    args.instructions ?? DEFAULT_CRITIQUE_INSTRUCTIONS,
    'Reply with exactly APPROVED and nothing else if no meaningful improvement is possible.',
    '',
    'Question:',
    args.question,
    '',
    'Draft answer:',
    args.draft,
  ].join('\n');
};

const buildRevisionPrompt = (args: {
  question: string;
  draft: string;
  critique: string;
}): string => {
  return [
    'Improve the draft answer using the critique. Respond with the final answer only — no preamble, no commentary about the revision.',
    '',
    'Question:',
    args.question,
    '',
    'Draft answer:',
    args.draft,
    '',
    'Critique:',
    args.critique,
  ].join('\n');
};

const isApproved = (critique: string): boolean => {
  const trimmed = critique.trim();
  return trimmed === 'APPROVED' || trimmed === 'APPROVED.';
};

export type ReflectionResult = {
  text: string;
  /** True when the returned text differs from the draft. */
  applied: boolean;
  reason:
    | 'revised'
    | 'approved'
    | 'skipped'
    | 'critique_failed'
    | 'revision_failed';
};

const runRevision = async (args: {
  agentId: string;
  projectIds?: number[];
  question: string;
  draft: string;
  critique: string;
  temperature?: number | null;
}): Promise<ReflectionResult> => {
  try {
    const revised = await reasoningCompletion.runReasoningCompletion({
      agentId: args.agentId,
      projectIds: args.projectIds,
      prompt: buildRevisionPrompt({
        question: args.question,
        draft: args.draft,
        critique: args.critique,
      }),
      temperature: args.temperature ?? undefined,
    });
    if (revised.trim().length === 0) {
      return { text: args.draft, applied: false, reason: 'revision_failed' };
    }
    log('runRevision: revised agentId=%s', args.agentId);
    return { text: revised, applied: true, reason: 'revised' };
  } catch (error) {
    log(
      'runRevision: failed agentId=%s error=%s',
      args.agentId,
      error instanceof Error ? error.message : String(error)
    );
    return { text: args.draft, applied: false, reason: 'revision_failed' };
  }
};

/**
 * Reflect mode: critique the draft, then revise it. Failures and approvals
 * fall back to the draft — reflection must never make a generation worse or
 * fail a request that already has an answer.
 */
export const applyReflection = async (args: {
  agentId: string;
  projectIds?: number[];
  reasoning: ReasoningConfig;
  messages: ReasoningMessage[];
  draft: string;
  temperature?: number | null;
}): Promise<ReflectionResult> => {
  if (args.reasoning.mode !== 'reflect' || args.draft.trim().length === 0) {
    return { text: args.draft, applied: false, reason: 'skipped' };
  }

  const question = formatQuestion(args.messages);
  const critiqueOverride = args.reasoning.critique ?? {};

  let critique: string;
  try {
    critique = await reasoningCompletion.runReasoningCompletion({
      agentId: args.agentId,
      projectIds: args.projectIds,
      aiProviderId: critiqueOverride.aiProviderId,
      model: critiqueOverride.model,
      prompt: buildCritiquePrompt({
        question,
        draft: args.draft,
        instructions: critiqueOverride.prompt,
      }),
    });
  } catch (error) {
    log(
      'applyReflection: critique failed agentId=%s error=%s',
      args.agentId,
      error instanceof Error ? error.message : String(error)
    );
    return { text: args.draft, applied: false, reason: 'critique_failed' };
  }

  if (isApproved(critique)) {
    log('applyReflection: draft approved agentId=%s', args.agentId);
    return { text: args.draft, applied: false, reason: 'approved' };
  }

  return runRevision({ ...args, question, critique });
};

export const recordReasoningSummary = async (args: {
  generationId: string;
  summary: { mode: string; applied: boolean; reason: string };
}): Promise<void> => {
  try {
    const generation = await db.Generation.findOne({
      where: { publicId: args.generationId },
    });
    if (!generation) return;
    await updateGenerationRecord({
      publicId: args.generationId,
      metadata: {
        ...(generation.metadata ?? {}),
        reasoning: args.summary,
      },
    });
  } catch (error) {
    log(
      'recordReasoningSummary: failed generationId=%s error=%s',
      args.generationId,
      error instanceof Error ? error.message : String(error)
    );
  }
};

type ReflectableResult = {
  text: string;
  response?: { messages?: Array<unknown>; modelId?: string };
};

/**
 * Pipeline hook: applies reflect mode to a completed raw generation result
 * in place — the trace, completion event, and API response are all built
 * from the final text afterwards. Records the outcome on the generation
 * record's `metadata.reasoning` (fire-and-forget).
 */
export const maybeApplyReflectionToResult = async (args: {
  reasoningConfig?: ReasoningConfig | null;
  agentId: string;
  generationId: string;
  messages: ReasoningMessage[];
  result: ReflectableResult;
  temperature?: number | null;
}): Promise<void> => {
  if (args.reasoningConfig?.mode !== 'reflect') return;

  const reflection = await applyReflection({
    agentId: args.agentId,
    reasoning: args.reasoningConfig,
    messages: args.messages,
    draft: args.result.text,
    temperature: args.temperature,
  });

  if (reflection.applied) {
    args.result.text = reflection.text;
    // The draft's responseMessages no longer match the final text — drop
    // them so conversation replay does not resurrect the draft.
    if (args.result.response) {
      args.result.response = { ...args.result.response, messages: undefined };
    }
  }

  void recordReasoningSummary({
    generationId: args.generationId,
    summary: {
      mode: 'reflect',
      applied: reflection.applied,
      reason: reflection.reason,
    },
  });
};

/**
 * Records the reflection outcome on the generation record's metadata
 * (merged, fire-and-forget) — same observability pattern as
 * `metadata.extraction`.
 */
