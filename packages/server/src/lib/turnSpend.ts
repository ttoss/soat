import type { LanguageModelUsage } from 'ai';

const addCounts = (
  a: number | undefined,
  b: number | undefined
): number | undefined => {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
};

const INPUT_DETAILS = [
  'noCacheTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const;
const OUTPUT_DETAILS = ['textTokens', 'reasoningTokens'] as const;

const sumDetails = <K extends string>(
  keys: readonly K[],
  a: Partial<Record<K, number | undefined>> | undefined,
  b: Partial<Record<K, number | undefined>> | undefined
): Record<K, number | undefined> => {
  const summed = {} as Record<K, number | undefined>;
  for (const key of keys) summed[key] = addCounts(a?.[key], b?.[key]);
  return summed;
};

/** Two usages summed field by field; a field neither reports stays absent. */
export const addUsage = (
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined
): LanguageModelUsage | undefined => {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: addCounts(a.inputTokens, b.inputTokens),
    inputTokenDetails: sumDetails(
      INPUT_DETAILS,
      a.inputTokenDetails,
      b.inputTokenDetails
    ),
    outputTokens: addCounts(a.outputTokens, b.outputTokens),
    outputTokenDetails: sumDetails(
      OUTPUT_DETAILS,
      a.outputTokenDetails,
      b.outputTokenDetails
    ),
    totalTokens: addCounts(a.totalTokens, b.totalTokens),
  };
};

const usageOfStep = (step: unknown): LanguageModelUsage | undefined => {
  if (!step || typeof step !== 'object' || !('usage' in step)) return undefined;
  const { usage } = step;
  if (!usage || typeof usage !== 'object' || !('inputTokens' in usage)) {
    return undefined;
  }
  return usage as LanguageModelUsage;
};

/** What the completed steps of a turn spent; `undefined` when none reported. */
export const sumStepUsage = (
  steps: readonly unknown[]
): LanguageModelUsage | undefined => {
  return steps.reduce<LanguageModelUsage | undefined>((total, step) => {
    return addUsage(total, usageOfStep(step));
  }, undefined);
};

/**
 * The provider calls a turn completed before it threw, carried on the error to
 * `recordGenerationFailure` — the one place a failed segment is metered, a frame
 * or more above the run that knows its steps.
 */
const spentBeforeFailure = new WeakMap<object, LanguageModelUsage>();

/** Returns `error`, carrying `usage` when there is any to carry. */
export const carrySpentUsage = (args: {
  error: unknown;
  usage: LanguageModelUsage | undefined;
}): unknown => {
  if (args.usage && typeof args.error === 'object' && args.error !== null) {
    spentBeforeFailure.set(args.error, args.usage);
  }
  return args.error;
};

export const spentUsageOf = (
  error: unknown
): LanguageModelUsage | undefined => {
  return typeof error === 'object' && error !== null
    ? spentBeforeFailure.get(error)
    : undefined;
};
