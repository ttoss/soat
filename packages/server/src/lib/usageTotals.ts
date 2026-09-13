/**
 * The provider's reported token counts, and the roll-up shape every usage
 * surface reports them in.
 *
 * Its own leaf because two very different callers need the same reading. The
 * meter reads a live `LanguageModelUsage` off a finished call; the transcript
 * reads the same object back out of a stored step, months later, as untyped
 * JSON. Written twice, the two would drift on exactly the fields that are
 * easiest to forget — which is what left the transcript reporting three of the
 * five dimensions while the meter recorded all five.
 */
import { isPlainObject } from './plainObject';

/**
 * The token/cost roll-up every usage surface reports, in one shape.
 *
 * A step, a generation, a session, an orchestration run, an aggregate bucket
 * and a receipt are the same figures; reported under different field sets they
 * could not be summed by one client type. Tokens and cost only — a
 * `compute_second` or `gb_day` meter is the aggregate's `components` array.
 */
export type UsageTotals = {
  cost_usd: number | null;
  input_tokens: number;
  /**
   * The part of the prompt priced at the plain input rate. Reported beside
   * `input_tokens` because the three input dimensions partition the prompt and
   * only the component rows knew it: `input_tokens` here is the full prompt,
   * while the component of that name is this figure.
   */
  uncached_input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
};

/** The five dimensions a provider reports, each defaulting to 0. */
export type UsageTokens = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

const ZERO_TOKENS: UsageTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

const numberOr0 = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const detailsAt = (value: unknown): Record<string, unknown> => {
  return isPlainObject(value) ? value : {};
};

/**
 * Reads a provider usage object — live or read back from storage — into the
 * five counts. Every field defaults to 0 so a provider that omits a breakdown
 * records 0 rather than null and the counts stay summable.
 */
export const readReportedUsage = (value: unknown): UsageTokens => {
  if (!isPlainObject(value)) return ZERO_TOKENS;
  const input = detailsAt(value.inputTokenDetails);
  const output = detailsAt(value.outputTokenDetails);
  return {
    inputTokens: numberOr0(value.inputTokens),
    outputTokens: numberOr0(value.outputTokens),
    cachedTokens: numberOr0(input.cacheReadTokens),
    cacheWriteTokens: numberOr0(input.cacheWriteTokens),
    reasoningTokens: numberOr0(output.reasoningTokens),
  };
};

/**
 * The reported counts as the shared roll-up shape.
 *
 * `cost_usd` is null: a price belongs to a metered event, and this reads a
 * provider's own report. A caller with an event in hand fills it from there.
 *
 * `inputTokens` is the whole prompt as the provider reported it, so the
 * uncached part is what is left after the two cache dimensions — the same
 * partition `buildTokenComponents` stores.
 */
export const usageTotalsFromReported = (tokens: UsageTokens): UsageTotals => {
  return {
    cost_usd: null,
    input_tokens: tokens.inputTokens,
    uncached_input_tokens: Math.max(
      0,
      tokens.inputTokens - tokens.cachedTokens - tokens.cacheWriteTokens
    ),
    output_tokens: tokens.outputTokens,
    cached_tokens: tokens.cachedTokens,
    cache_write_tokens: tokens.cacheWriteTokens,
    reasoning_tokens: tokens.reasoningTokens,
  };
};

/**
 * The same counts in OpenAI's field names.
 *
 * The one place a usage figure is not reported as `UsageTotals`: the chat
 * completions endpoint exists so an OpenAI SDK can target SOAT by base URL
 * alone, and that SDK reads these names. Compatibility beats uniformity here,
 * and only here.
 */
export const openAiUsageFromReported = (tokens: UsageTokens) => {
  return {
    prompt_tokens: tokens.inputTokens,
    completion_tokens: tokens.outputTokens,
    total_tokens: tokens.inputTokens + tokens.outputTokens,
    prompt_tokens_details: { cached_tokens: tokens.cachedTokens },
    completion_tokens_details: { reasoning_tokens: tokens.reasoningTokens },
  };
};
