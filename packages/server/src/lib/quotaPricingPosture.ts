/**
 * The `on_unpriced` posture of a `cost_usd` quota — what an `enforce` cap does
 * over a pricing blackout (a window whose metered events none are priced).
 *
 * Kept in its own module (like `quotaWindows.ts` and `quotaImmutability.ts`) so
 * the vocabulary has one home and `quotas.ts` can re-export it: the REST route,
 * the formation module, and the enforcement check must never drift apart on
 * what the posture means.
 */

export const QUOTA_ON_UNPRICED = ['block', 'allow'] as const;

export type QuotaOnUnpriced = (typeof QUOTA_ON_UNPRICED)[number];

/**
 * The posture an evaluation holds a `cost_usd` quota to when its window is an
 * unpriced blackout. `block` is the default — a cap that cannot measure the
 * spend it caps refuses it — and is also what a row stored before the column
 * existed carries, so legacy quotas are held to the safe posture rather than
 * the silent one.
 */
export const resolveOnUnpriced = (value: unknown): QuotaOnUnpriced => {
  return value === 'allow' ? 'allow' : 'block';
};

/**
 * `on_unpriced` is storable only where it can act: pricing is a `cost_usd`
 * dependency, so on any other metric the field would be accepted-but-inert —
 * the exact state `SCOPES_BY_METRIC` exists to make unrepresentable.
 */
export const validateOnUnpriced = (args: {
  metric: string;
  onUnpriced: unknown;
}): string | null => {
  if (args.onUnpriced === undefined || args.onUnpriced === null) return null;
  if (
    !(QUOTA_ON_UNPRICED as readonly string[]).includes(
      args.onUnpriced as string
    )
  ) {
    return `on_unpriced must be one of ${QUOTA_ON_UNPRICED.join(' / ')}.`;
  }
  if (args.metric !== 'cost_usd') {
    return 'on_unpriced only applies to metric "cost_usd".';
  }
  return null;
};
