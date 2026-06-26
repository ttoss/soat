import type { JSONValue } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitEvent } from './eventBus';
import { updateGenerationRecord } from './generations';

const log = createDebug('soat:reasoning');

/**
 * Hard caps for a reasoning pipeline. These bound the cost of a user-defined
 * thinking strategy — a pipeline is pure meta-cognition, never a workflow
 * engine (see `orchestrationEngine.ts` for that layer).
 */
export const MAX_STEPS = 8;
export const MAX_FANOUT = 5;
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

export type PerspectiveConfig = {
  name?: string;
  prompt?: string;
  aiProviderId?: string;
  model?: string;
};

export type ReasoningStep = {
  /** Unique, human-readable step name; referenced as `{steps.<name>}`. */
  name: string;
  /** `completion` (default) runs one call; `fanout` runs N perspectives. */
  kind?: 'completion' | 'fanout';
  /** Prompt template — supports `{question}`, `{draft}`, `{steps.<name>}`. */
  prompt: string;
  aiProviderId?: string;
  model?: string;
  temperature?: number;
  /** Marks the step whose output is the final answer (else the last step). */
  output?: boolean;
  /** If the step output equals this, halt and keep the current draft. */
  haltIfEquals?: string;
  /** Fanout only — number of auto-named perspectives (2–5). */
  count?: number;
  /** Fanout only — explicit perspective objects (overrides `count`). */
  perspectives?: PerspectiveConfig[];
  /** Fanout only — rounds of perspective turns (default 1, max 3). */
  rounds?: number;
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

// ── Validation ─────────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const invalid = (message: string): never => {
  throw new DomainError('INVALID_REASONING_CONFIG', message);
};

const isStringOrUndefined = (value: unknown): boolean => {
  return value === undefined || typeof value === 'string';
};

/** Matches the same template tokens `resolveTemplate` resolves at runtime. */
const TEMPLATE_TOKEN = /\{([\w.]+)\}/g;

/**
 * Extracts the step names referenced via `{steps.<name>}` in a prompt. Mirrors
 * the runtime token grammar so validation and resolution stay in lockstep.
 */
const extractStepRefs = (prompt: unknown): string[] => {
  if (typeof prompt !== 'string') return [];
  const refs: string[] = [];
  for (const match of prompt.matchAll(TEMPLATE_TOKEN)) {
    const token = match[1];
    if (token.startsWith('steps.')) refs.push(token.slice('steps.'.length));
  }
  return refs;
};

/**
 * Rejects a step whose prompt (or any of its perspective prompts) references a
 * `{steps.<name>}` that is not an earlier, declared step. Without this, a typo
 * or forward reference silently resolves to an empty string at runtime instead
 * of failing fast.
 */
const validateStepReferences = (args: {
  step: Record<string, unknown>;
  index: number;
  priorNames: Set<string>;
}): void => {
  const prompts: unknown[] = [args.step.prompt];
  if (Array.isArray(args.step.perspectives)) {
    for (const perspective of args.step.perspectives) {
      if (isPlainObject(perspective)) prompts.push(perspective.prompt);
    }
  }
  for (const prompt of prompts) {
    for (const ref of extractStepRefs(prompt)) {
      if (!args.priorNames.has(ref)) {
        invalid(
          `reasoning.steps[${args.index}] references unknown step '${ref}'; a {steps.<name>} token must name an earlier step.`
        );
      }
    }
  }
};

/**
 * Validates the explicit `perspectives` of a fanout step. Only the array length
 * is bounded elsewhere; this enforces the shape the runtime relies on.
 */
const validatePerspectives = (
  step: Record<string, unknown>,
  index: number
): void => {
  if (!Array.isArray(step.perspectives)) return;
  for (const [entryIndex, perspective] of step.perspectives.entries()) {
    const path = `reasoning.steps[${index}].perspectives[${entryIndex}]`;
    if (!isPlainObject(perspective)) {
      invalid(`${path} must be an object.`);
      continue;
    }
    if (!isStringOrUndefined(perspective.name)) {
      invalid(`${path}.name must be a string.`);
    }
    if (!isStringOrUndefined(perspective.prompt)) {
      invalid(`${path}.prompt must be a string.`);
    }
    if (!isStringOrUndefined(perspective.aiProviderId)) {
      invalid(`${path}.aiProviderId must be a string.`);
    }
    if (!isStringOrUndefined(perspective.model)) {
      invalid(`${path}.model must be a string.`);
    }
  }
};

const resolveFanoutRounds = (step: Record<string, unknown>, index: number) => {
  const rounds = step.rounds === undefined ? 1 : step.rounds;
  if (typeof rounds !== 'number' || rounds < 1 || rounds > MAX_ROUNDS) {
    invalid(
      `reasoning.steps[${index}].rounds must be between 1 and ${MAX_ROUNDS}.`
    );
  }
  return rounds as number;
};

const resolveFanoutWidth = (step: Record<string, unknown>, index: number) => {
  if (Array.isArray(step.perspectives)) {
    const width = step.perspectives.length;
    if (width < 2 || width > MAX_FANOUT) {
      invalid(
        `reasoning.steps[${index}].perspectives must have 2–${MAX_FANOUT} entries.`
      );
    }
    return width;
  }
  const count = step.count;
  if (typeof count !== 'number' || count < 2 || count > MAX_FANOUT) {
    invalid(
      `reasoning.steps[${index}] fanout needs count (2–${MAX_FANOUT}) or perspectives.`
    );
  }
  return count as number;
};

const validateStepContent = (
  step: Record<string, unknown>,
  index: number
): void => {
  if (typeof step.prompt !== 'string' || step.prompt.trim().length === 0) {
    invalid(`reasoning.steps[${index}].prompt is required.`);
  }
  if (!isStringOrUndefined(step.aiProviderId)) {
    invalid(`reasoning.steps[${index}].aiProviderId must be a string.`);
  }
  if (!isStringOrUndefined(step.model)) {
    invalid(`reasoning.steps[${index}].model must be a string.`);
  }
};

const validateStepIdentity = (args: {
  step: Record<string, unknown>;
  index: number;
  names: Set<string>;
}): 'completion' | 'fanout' => {
  const { step, index, names } = args;
  if (typeof step.name !== 'string' || step.name.trim().length === 0) {
    invalid(`reasoning.steps[${index}].name is required.`);
  }
  const name = step.name as string;
  if (names.has(name)) {
    invalid(`reasoning.steps[${index}].name '${name}' is duplicated.`);
  }
  names.add(name);

  const kind = step.kind ?? 'completion';
  if (kind !== 'completion' && kind !== 'fanout') {
    invalid(`reasoning.steps[${index}].kind '${String(kind)}' is invalid.`);
  }
  return kind as 'completion' | 'fanout';
};

const validateStep = (args: {
  step: unknown;
  index: number;
  names: Set<string>;
}): number => {
  if (!isPlainObject(args.step)) {
    invalid(`reasoning.steps[${args.index}] must be an object.`);
    return 1;
  }
  const step = args.step;
  const kind = validateStepIdentity({
    step,
    index: args.index,
    names: args.names,
  });
  validateStepContent(step, args.index);
  if (kind !== 'fanout') return 1;
  validatePerspectives(step, args.index);
  return (
    resolveFanoutWidth(step, args.index) * resolveFanoutRounds(step, args.index)
  );
};

const validatePipelineSteps = (steps: unknown): void => {
  if (!Array.isArray(steps) || steps.length === 0) {
    invalid('reasoning.steps is required and must be a non-empty array.');
    return;
  }
  if (steps.length > MAX_STEPS) {
    invalid(`reasoning.steps cannot exceed ${MAX_STEPS} steps.`);
  }
  const names = new Set<string>();
  let totalCompletions = 0;
  for (const [index, step] of steps.entries()) {
    // `names` holds only earlier steps here — validateStep adds this step's
    // name — so reference checking against it enforces earlier-only ordering.
    if (isPlainObject(step)) {
      validateStepReferences({ step, index, priorNames: names });
    }
    totalCompletions += validateStep({ step, index, names });
  }
  if (totalCompletions > MAX_TOTAL_COMPLETIONS) {
    invalid(
      `reasoning pipeline exceeds ${MAX_TOTAL_COMPLETIONS} total completions.`
    );
  }
};

/**
 * Validates a reasoning config at every write choke point (agent create/update
 * and the per-generate override). Throws `INVALID_REASONING_CONFIG` on any
 * structural problem. A null/undefined config or an effort-only config is
 * always valid.
 */
export const validateReasoningConfig = (config: unknown): void => {
  if (config === null || config === undefined) return;
  if (!isPlainObject(config)) {
    invalid('reasoning must be an object.');
    return;
  }
  const mode = config.mode;
  if (mode !== undefined && mode !== 'none' && mode !== 'pipeline') {
    invalid(`reasoning.mode '${String(mode)}' is invalid.`);
  }
  if (mode !== 'pipeline') return;
  validatePipelineSteps(config.steps);
};

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
