/**
 * The quota write-shape: the scope/metric/mode vocabulary and the create-time
 * rules over it.
 *
 * Kept in its own module (like `quotaWindows.ts` and `quotaImmutability.ts`) so
 * the rules have one home and `quotas.ts` can re-export them: the REST route
 * and the formation module must never drift apart on what a valid quota is.
 */

import { validateOnUnpriced } from './quotaPricingPosture';
import { QUOTA_WINDOWS } from './quotaWindows';

export const QUOTA_SCOPES = ['project', 'api_key', 'agent', 'actor'] as const;
export const QUOTA_METRICS = ['requests', 'tokens', 'cost_usd'] as const;
export const QUOTA_MODES = ['enforce', 'monitor'] as const;

export type QuotaScope = (typeof QUOTA_SCOPES)[number];
export type QuotaMetric = (typeof QUOTA_METRICS)[number];
export type QuotaMode = (typeof QUOTA_MODES)[number];

export const isOneOf = <T extends readonly string[]>(
  values: T,
  value: unknown
): value is T[number] => {
  return (
    typeof value === 'string' && (values as readonly string[]).includes(value)
  );
};

/**
 * `limit` must be a number > 0. For `requests` and `tokens` it must be a
 * positive integer; fractional limits are valid only for `cost_usd`.
 */
export const validateQuotaLimit = (args: {
  metric: QuotaMetric;
  limit: unknown;
}): string | null => {
  const value =
    typeof args.limit === 'number'
      ? args.limit
      : typeof args.limit === 'string' && args.limit.trim() !== ''
        ? Number(args.limit)
        : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return 'limit must be a number greater than 0.';
  }
  if (args.metric !== 'cost_usd' && !Number.isInteger(value)) {
    return `limit must be a positive integer for metric "${args.metric}".`;
  }
  return null;
};

/**
 * The scopes each metric can actually be enforced for. A combination outside
 * this table is rejected at create time rather than stored as a silent no-op:
 * enforcement aggregates real attribution, so a cap it cannot aggregate would
 * look healthy through the API while protecting nothing.
 *
 * - `requests` is counted by the request middleware, which sees the API key and
 *   the project — but not the agent or end user behind the call, so `agent` and
 *   `actor` are excluded.
 * - `tokens` / `cost_usd` aggregate the usage meter, which carries project,
 *   agent, and end-user (actor) attribution — but no API-key attribution, so
 *   `api_key` is excluded.
 *
 * Widening a row here is backward-compatible; narrowing one is not.
 */
const SCOPES_BY_METRIC: Record<QuotaMetric, readonly QuotaScope[]> = {
  requests: ['project', 'api_key'],
  tokens: ['project', 'agent', 'actor'],
  cost_usd: ['project', 'agent', 'actor'],
};

/**
 * Validates the immutable shape of a quota at create time. Returns a message on
 * the first problem, or `null` when valid. Pure — shared as the single source of
 * truth for the create/update rules.
 */
export const validateQuotaShape = (args: {
  scope: unknown;
  metric: unknown;
  window: unknown;
  mode: unknown;
  limit: unknown;
  onUnpriced?: unknown;
}): string | null => {
  if (!isOneOf(QUOTA_SCOPES, args.scope)) {
    return `scope must be one of ${QUOTA_SCOPES.join(' / ')}.`;
  }
  if (!isOneOf(QUOTA_METRICS, args.metric)) {
    return `metric must be one of ${QUOTA_METRICS.join(' / ')}.`;
  }
  if (!isOneOf(QUOTA_WINDOWS, args.window)) {
    return `window must be one of ${QUOTA_WINDOWS.join(' / ')}.`;
  }
  if (!isOneOf(QUOTA_MODES, args.mode)) {
    return `mode must be one of ${QUOTA_MODES.join(' / ')}.`;
  }
  if (!SCOPES_BY_METRIC[args.metric].includes(args.scope)) {
    return `scope "${args.scope}" is not valid for metric "${args.metric}".`;
  }
  const onUnpricedError = validateOnUnpriced({
    metric: args.metric,
    onUnpriced: args.onUnpriced,
  });
  if (onUnpricedError) return onUnpricedError;
  return validateQuotaLimit({ metric: args.metric, limit: args.limit });
};
