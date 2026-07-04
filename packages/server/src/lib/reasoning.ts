import type { JSONValue } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { emitEvent } from './eventBus';
import { updateGenerationRecord } from './generations';
import { validateReasoningConfig } from './reasoningValidation';

const log = createDebug('soat:reasoning');

/**
 * Hard caps for a reasoning pipeline. These bound the cost of a user-defined
 * thinking strategy — a pipeline is pure meta-cognition, never a workflow
 * engine (see `orchestrationEngine.ts` for that layer).
 */
export const MAX_STEPS = 8;
export const MAX_BRANCHES = 5;
export const MAX_ROUNDS = 3;
export const MAX_TOTAL_COMPLETIONS = 24;

/**
 * Latency bounds for a reasoning pipeline. A pipeline runs after the draft is
 * already produced, so an unbounded or hung step would silently add latency
 * (and cost) to a request that has otherwise succeeded. Each completion is
 * capped individually and the whole pipeline shares an overall deadline.
 */
export const REASONING_STEP_TIMEOUT_MS = 60_000;
export const REASONING_PIPELINE_TIMEOUT_MS = 120_000;

/**
 * Reasoning outcomes that mean the engine silently degraded to the plain
 * draft instead of delivering the requested pipeline. Emitting an event for
 * these makes the degradation detectable (deep thinking never fails a request,
 * so without this it is invisible).
 */
const FALLBACK_REASONS = new Set(['all_failed', 'output_failed', 'fallback']);

/**
 * True when a reasoning outcome reason represents a degradation to the draft
 * (as opposed to a clean completion or an intentional `halt_if_equals`
 * short-circuit). The single source of truth for both the webhook event and
 * the `metadata.reasoning.fallback` summary flag, so the two never disagree.
 */
export const isFallbackReason = (reason: string): boolean => {
  return FALLBACK_REASONS.has(reason);
};

export type ReasoningSummary = {
  mode: string;
  applied: boolean;
  reason: string;
  /** Number of steps that produced output. */
  stepsRun?: number;
  /** Number of step/perspective turns that failed and were dropped. */
  dropped?: number;
  /** True when the engine degraded to the plain draft. */
  fallback?: boolean;
};

/**
 * Emits a `agents.reasoning.fallback` event when a reasoning strategy degraded
 * to the draft, so silent degradation surfaces on webhooks. Synchronous and
 * best-effort — a missing project context is a no-op, never an error.
 */
export const emitReasoningFallbackEvent = (args: {
  projectId?: number;
  projectPublicId?: string;
  generationId: string;
  mode: string;
  reason: string;
  data?: Record<string, unknown>;
}): void => {
  if (!FALLBACK_REASONS.has(args.reason)) return;
  if (args.projectId === undefined || !args.projectPublicId) {
    log(
      'emitReasoningFallbackEvent: missing project context, skipping generationId=%s',
      args.generationId
    );
    return;
  }
  emitEvent({
    type: 'agents.reasoning.fallback',
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'generation',
    resourceId: args.generationId,
    data: { mode: args.mode, reason: args.reason, ...(args.data ?? {}) },
    timestamp: new Date().toISOString(),
  });
};

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type ReasoningBranch = {
  /** Label used for transcript/observability; falls back to the step name. */
  name?: string;
  /** Falls back to the step-level `prompt` when omitted. */
  prompt?: string;
  aiProviderId?: string;
  model?: string;
  temperature?: number;
};

export type ReasoningStep = {
  /** Unique, human-readable step name; referenced as `{steps.<name>}`. Must not contain '.'. */
  name: string;
  /** Prompt template — required unless every branch supplies its own. */
  prompt?: string;
  /** Omit for a single implicit branch (today's "completion"). 1–5 entries. */
  branches?: ReasoningBranch[];
  /** Rounds of branch turns (default 1, max 3). >1 requires a `{transcript}` reference. */
  rounds?: number;
  /** Step-level defaults for branches that omit their own. */
  aiProviderId?: string;
  model?: string;
  temperature?: number;
  /** Marks the step whose output is the final answer (else the last step). */
  output?: boolean;
  /** Single-branch steps only. If the step output equals this, halt and keep the current draft. */
  haltIfEquals?: string;
};

export type ReasoningConfig = {
  /** Provider-native reasoning effort, forwarded to providers that support it. */
  effort?: ReasoningEffort;
  /** Orchestrated reasoning strategy. Defaults to none. */
  mode?: 'none' | 'pipeline';
  /** Pipeline only — ordered steps run after the base draft. */
  steps?: ReasoningStep[];
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
  if (!config.mode && !config.effort) return null;
  return config;
};

// Validation lives in `reasoningValidation.ts` (split out to stay under the
// file-length lint cap); re-exported here so callers keep importing from the
// module that owns the reasoning types and runtime config resolution.
export { validateReasoningConfig };

// ── Provider-native effort ───────────────────────────────────────────────────

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
 * generation context in one step. Validates the per-generate override so a bad
 * override fails up front rather than mid-generation.
 */
export const resolveReasoningForContext = (args: {
  typedAgent: { reasoningConfig: unknown };
  override?: object;
  provider: string;
}) => {
  if (args.override !== undefined) validateReasoningConfig(args.override);
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

/**
 * Records the reasoning outcome on the generation record's metadata (merged,
 * fire-and-forget) — same observability pattern as `metadata.extraction`.
 */
export const recordReasoningSummary = async (args: {
  generationId: string;
  summary: ReasoningSummary;
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
