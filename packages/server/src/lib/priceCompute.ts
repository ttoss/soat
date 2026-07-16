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
