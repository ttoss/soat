/**
 * The rate an embedding call is metered at.
 *
 * The embedding stack is deployment configuration (`EMBEDDING_PROVIDER` /
 * `EMBEDDING_MODEL`), not an `AiProvider` row, so its rate is configuration
 * too and the price book does not reach it: no tier can name a call that
 * carries no provider record, and a per-project embedding rate is a markup
 * nothing here sells. The variable sits beside the model it prices, so the
 * operator who chooses one sets the other.
 *
 * Denominated per **million** tokens because that is the unit every vendor
 * publishes — a per-token variable invites a factor-of-a-million typo on a
 * figure that is frozen onto every event it prices.
 */

export const EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV =
  'EMBEDDING_INPUT_1M_TOKEN_PRICE_USD';

const TOKENS_PER_MILLION_DECIMAL_PLACES = 6;

/**
 * Plain decimal only. Scientific notation parses as a number but cannot be
 * shifted as a string, and a rate a human wrote as `2e-2` is as likely to be a
 * mistake as an intention — so it is refused rather than guessed at.
 */
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

const invalid = (value: string): Error => {
  return new Error(
    `${EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV} must be a non-negative plain decimal ` +
      `number of USD per million tokens (e.g. "0.02"); got '${value}'.`
  );
};

/**
 * Divides by a million in decimal rather than binary: `0.07 / 1e6` is
 * `6.999999999999999e-8` as a float, and this figure is frozen onto every
 * embedding event, so the rate an operator wrote is the rate that gets stored.
 */
const shiftDecimalLeft = (args: { value: string; places: number }): string => {
  const [whole, fraction = ''] = args.value.split('.');
  const decimals = fraction.length + args.places;
  const digits = `${whole}${fraction}`.padStart(decimals + 1, '0');
  const shifted = `${digits.slice(0, digits.length - decimals)}.${digits.slice(
    digits.length - decimals
  )}`;
  return shifted.replace(/0+$/, '').replace(/\.$/, '');
};

/**
 * USD per input token, from a value denominated per million tokens.
 *
 * Unset is zero: a deployment that states no rate charges nothing, which is
 * true of a local model and is the deployment's own claim about its cost
 * anywhere else. An unparseable value throws instead, so a rate that was meant
 * to be set fails loudly rather than metering at zero.
 */
export const parseEmbeddingInputTokenPriceUsd = (args: {
  value: string | undefined;
}): string => {
  const raw = args.value?.trim();
  if (!raw) return '0';
  if (!PLAIN_DECIMAL.test(raw)) throw invalid(raw);
  return shiftDecimalLeft({
    value: raw,
    places: TOKENS_PER_MILLION_DECIMAL_PLACES,
  });
};

export const readEmbeddingInputTokenPriceUsd = (): string => {
  return parseEmbeddingInputTokenPriceUsd({
    value: process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV],
  });
};

/**
 * The boot line for a deployment that will meter embeddings at zero without
 * having said so.
 *
 * An unset rate is a valid configuration and the recorded cost is a real zero,
 * which is why this is a log line and not a refusal. But zero is also what a
 * deployment paying a vendor per token gets by omission, and the figure is
 * frozen onto every event — so the one boot where it can still be caught cheaply
 * is worth a sentence.
 *
 * Silent for a local model, where nothing is billed per token and the line would
 * be noise on every dev boot.
 */
export const embeddingPriceWarning = (args: {
  provider: string | undefined;
  value: string | undefined;
}): string | null => {
  if (!args.provider || args.provider === 'ollama') return null;
  if (args.value?.trim()) return null;
  return (
    `${EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV} is not set, so embeddings on ` +
    `provider '${args.provider}' are metered at $0. Set it to this model's ` +
    'USD per million input tokens for cost usage and quotas to reflect them.'
  );
};
