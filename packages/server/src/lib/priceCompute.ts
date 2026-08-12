// Pure pricing/metering arithmetic and shape helpers, kept free of any DB
// access so they can be unit-tested directly and reused by every write path.
// `priceBook.ts` and `usage.ts` compose these with persistence.

export const DEFAULT_METER_TYPE = 'llm_tokens';

// Cost is stored with enough decimal places that per-token unit prices
// (e.g. 0.0000025 USD/token) stay exact for small calls.
const COST_DECIMALS = 10;

/**
 * A single component's cost: `quantity × unitPrice`, or null when the component
 * is unpriced (no price row, or a non-billable detail component). Usage is
 * never lost because pricing lagged — the quantity is still recorded.
 */
export const computeComponentCostUsd = (args: {
  quantity: number;
  unitPrice: number | null | undefined;
}): string | null => {
  if (args.unitPrice === null || args.unitPrice === undefined) return null;
  return (args.quantity * args.unitPrice).toFixed(COST_DECIMALS);
};

/**
 * Sums component costs into an event total. Null when no component was priced
 * (mirrors the component-level "captured but not priced" semantics) rather than
 * reporting a misleading 0.
 */
export const sumComponentCostUsd = (
  costs: Array<string | null>
): string | null => {
  const priced = costs.filter((cost): cost is string => {
    return cost !== null;
  });
  if (priced.length === 0) return null;
  const total = priced.reduce((acc, cost) => {
    return acc + Number(cost);
  }, 0);
  return total.toFixed(COST_DECIMALS);
};

/** Decimal places in a DECIMAL string: `'0.150'` → 3, `'12'` → 0. */
const decimalPlaces = (value: string): number => {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
};

/** A DECIMAL string as an integer at `scale` decimal places: `'1.25'`@4 → 12500n. */
const toScaledInt = (value: string, scale: number): bigint => {
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const dot = abs.indexOf('.');
  const whole = dot === -1 ? abs : abs.slice(0, dot);
  const fraction = dot === -1 ? '' : abs.slice(dot + 1);
  const digits = `${whole || '0'}${fraction.padEnd(scale, '0')}`;
  const scaled = BigInt(digits);
  return negative ? -scaled : scaled;
};

/**
 * Sums measured quantities exactly.
 *
 * Quantities arrive as DECIMAL strings and a rollup sums many of them, so a
 * plain `+=` on numbers accumulates binary-float error into a figure a customer
 * reads: 2070.155 compute-seconds was reported as 2070.1550000000016. Costs
 * never showed this because `sumComponentCostUsd` fixes the scale on the way
 * out, but a quantity has no single scale to round to — `gb_day` carries nine
 * decimals where tokens carry none — so rounding would either drop precision
 * from the small measures or leave the drift in place.
 *
 * Instead the summands are widened to a common scale, added as integers (exact
 * at any magnitude, via `bigint`), and converted back once. The result is the
 * double nearest the true decimal, which is what serializes cleanly.
 */
export const sumQuantities = (quantities: string[]): number => {
  if (quantities.length === 0) return 0;

  const scale = quantities.reduce((acc, quantity) => {
    return Math.max(acc, decimalPlaces(quantity));
  }, 0);

  const total = quantities.reduce((acc, quantity) => {
    return acc + toScaledInt(quantity, scale);
  }, 0n);

  if (scale === 0) return Number(total);

  const negative = total < 0n;
  const digits = (negative ? -total : total)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return Number(`${negative ? '-' : ''}${whole}.${fraction}`);
};

export type TokenComponent = {
  component: string;
  quantity: number;
  unit: string;
  billable: boolean;
};

/**
 * Decomposes an LLM call's token counts into disjoint, additive components.
 * `input_tokens` is the *uncached* input (cached tokens are billed separately
 * at their own rate), and `reasoning_tokens` is a non-billable detail — it is a
 * subset of `output_tokens` reported for visibility, so it is never priced and
 * never double-counted into billable totals. Zero-quantity billable components
 * are dropped so a call only records the dimensions it actually used.
 */
export const buildTokenComponents = (tokens: {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}): TokenComponent[] => {
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedTokens);
  const components: TokenComponent[] = [
    {
      component: 'input_tokens',
      quantity: uncachedInput,
      unit: 'token',
      billable: true,
    },
    {
      component: 'output_tokens',
      quantity: tokens.outputTokens,
      unit: 'token',
      billable: true,
    },
  ];
  if (tokens.cachedTokens > 0) {
    components.push({
      component: 'cached_tokens',
      quantity: tokens.cachedTokens,
      unit: 'token',
      billable: true,
    });
  }
  if (tokens.reasoningTokens > 0) {
    components.push({
      component: 'reasoning_tokens',
      quantity: tokens.reasoningTokens,
      unit: 'token',
      billable: false,
    });
  }
  return components;
};

/**
 * Validates a single price-book upsert row's shape (transport-independent, so
 * REST and any future formation path share it). Returns a message describing
 * the violation, or null when valid. `effective_from` immutability is enforced
 * separately at the DB layer against the current time.
 */
export const validatePriceInput = (args: {
  component?: string;
  unit?: string;
  unitPrice?: number | null;
}): string | null => {
  if (!args.component) return 'component is required.';
  if (!args.unit) return 'unit is required.';
  if (
    args.unitPrice === null ||
    args.unitPrice === undefined ||
    Number.isNaN(args.unitPrice) ||
    args.unitPrice < 0
  ) {
    return 'unit_price must be a non-negative number.';
  }
  return null;
};
