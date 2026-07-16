// Pure pricing arithmetic and the price-shape validation rule, kept free of any
// DB access so they can be unit-tested directly and reused by every price write
// path. `priceBook.ts` composes these with the persistence layer.

const PER_MILLION = 1_000_000;

export const DEFAULT_METER_TYPE = 'llm_tokens';

type PriceShapeArgs = {
  meterType: string;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  cachedPricePerM?: number | null;
  unitPrice?: number | null;
  unit?: string | null;
};

const validateTokenShape = (args: PriceShapeArgs): string | null => {
  if (args.inputPricePerM == null || args.outputPricePerM == null) {
    return 'llm_tokens prices require input_price_per_m and output_price_per_m.';
  }
  if (args.unitPrice != null || args.unit != null) {
    return 'llm_tokens prices must not set unit_price or unit.';
  }
  return null;
};

const validateUnitShape = (args: PriceShapeArgs): string | null => {
  if (args.unitPrice == null || !args.unit) {
    return `${args.meterType} prices require unit_price and unit.`;
  }
  const hasTokenPrice =
    args.inputPricePerM != null ||
    args.outputPricePerM != null ||
    args.cachedPricePerM != null;
  if (hasTokenPrice) {
    return `${args.meterType} prices must not set token prices (input/output/cached_price_per_m).`;
  }
  return null;
};

/**
 * Enforces the token-price XOR unit-price shape rule shared by every price
 * write path (the single source of truth per the modules rule). An
 * `llm_tokens` row must carry `input`/`output` per-million rates and no unit
 * price; every other meter type must carry `unit_price` + `unit` and no token
 * rates. Returns a message describing the violation, or null when the shape is
 * valid.
 */
export const validatePriceShape = (args: PriceShapeArgs): string | null => {
  return args.meterType === DEFAULT_METER_TYPE
    ? validateTokenShape(args)
    : validateUnitShape(args);
};

type ComputeCostArgs = {
  price: {
    meterType?: string;
    inputPricePerM: string | null;
    outputPricePerM: string | null;
    cachedPricePerM: string | null;
    unitPrice?: string | null;
  } | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  quantity?: number | null;
};

const computeTokenCost = (args: ComputeCostArgs): string | null => {
  const price = args.price;
  if (
    !price ||
    price.inputPricePerM === null ||
    price.outputPricePerM === null
  ) {
    return null;
  }
  const inputTokens = args.inputTokens ?? 0;
  const outputTokens = args.outputTokens ?? 0;
  const cachedTokens = args.cachedTokens ?? 0;
  const inputRate = Number(price.inputPricePerM);
  const outputRate = Number(price.outputPricePerM);
  const cachedRate =
    price.cachedPricePerM === null ? inputRate : Number(price.cachedPricePerM);
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const cost =
    (uncachedInput * inputRate +
      cachedTokens * cachedRate +
      outputTokens * outputRate) /
    PER_MILLION;
  return cost.toFixed(6);
};

/**
 * Computes a meter row's cost in USD from the price row that applies to it.
 * Branches on meter type: `llm_tokens` uses the per-million token formula
 * (cached input billed at the cached rate, falling back to the input rate when
 * unset; reasoning tokens are already part of `outputTokens`); every other type
 * is `quantity × unit_price`. Returns a fixed-precision string for the DECIMAL
 * column, or null when there is no price (or the price lacks the rate its type
 * needs — usage is recorded with `cost_usd = null` rather than lost).
 */
export const computeCostUsd = (args: ComputeCostArgs): string | null => {
  if (!args.price) return null;

  const meterType = args.price.meterType ?? DEFAULT_METER_TYPE;
  if (meterType === DEFAULT_METER_TYPE) {
    return computeTokenCost(args);
  }

  if (args.price.unitPrice == null || args.quantity == null) return null;
  return (args.quantity * Number(args.price.unitPrice)).toFixed(6);
};
