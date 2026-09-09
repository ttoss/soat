/**
 * What a breached quota is, and the response it becomes.
 *
 * Kept in its own module (like `quotaShape.ts` and `quotaWindows.ts`) so the
 * two enforcement families — the windowed evaluators in `quotaEnforcement.ts`
 * and the stock cap in `quotaStorage.ts` — share one breach vocabulary and one
 * error body without one importing the other.
 */

import { DomainError } from '../errors';
import type { UnpricedRow } from './costEnforceability';

/**
 * Why the quota refused the work.
 *
 * `limit_exceeded` is the ordinary case: the window aggregate reached the cap.
 * `unpriced_usage` is a `cost_usd` cap the platform cannot evaluate at all —
 * the window metered usage and priced none of it, so the aggregate is 0 no
 * matter what was actually spent. `storage_exceeded` is a stock cap: the
 * project's stored footprint is already over the byte limit, so what clears it
 * is deleting content.
 *
 * The three are not interchangeable, and what clears each is what separates
 * them: the first when the window rolls, the second when pricing is
 * configured, the third only when the corpus shrinks.
 */
export type QuotaBreachReason =
  'limit_exceeded' | 'unpriced_usage' | 'storage_exceeded';

/** The attribution every breach carries, whatever kind of cap raised it. */
type BreachedQuota = {
  quotaId: string;
  scope: string;
  scopeRef: string | null;
  metric: string;
  window: string;
  limit: number;
};

/**
 * A breach of a windowed cap, and the two fields that only such a cap has: a
 * window to reset and a `Retry-After` to promise. A union rather than optional
 * fields, so the response builder and the middleware reach them by narrowing
 * on `reason` instead of guarding a value that is always there.
 */
export type WindowedQuotaBreach = BreachedQuota & {
  reason: 'limit_exceeded' | 'unpriced_usage';
  resetsAt: Date;
  retryAfter: number;
  /** Populated only on an `unpriced_usage` breach — the rows to price. */
  unpricedRows?: UnpricedRow[];
};

/** A breach of a stock cap: no window, no retry, and a footprint to report. */
type StorageQuotaBreach = BreachedQuota & {
  reason: 'storage_exceeded';
  currentBytes: number;
};

export type QuotaBreach = WindowedQuotaBreach | StorageQuotaBreach;

/**
 * The DomainError for a breach — the shared source of the response body across
 * every enforcement point (the request middleware and the token/cost generation
 * gate). Error meta keys are snake_case to match the external REST contract.
 *
 * An `unpriced_usage` refusal is deliberately **not** a 429: waiting for the
 * window to reset changes nothing, so the `Retry-After` contract a 429 carries
 * would be a lie. It reports the unenforceable configuration instead, and omits
 * `resets_at` for the same reason. A `storage_exceeded` refusal follows that
 * precedent for the same reason — a stored total is not a rate.
 */
export const quotaBreachError = (breach: QuotaBreach): DomainError => {
  if (breach.reason === 'storage_exceeded') {
    return new DomainError(
      'QUOTA_STORAGE_EXCEEDED',
      `Storage quota ${breach.quotaId} exceeded: the project stores more than its ${breach.limit}-byte limit.`,
      {
        quota_id: breach.quotaId,
        metric: breach.metric,
        limit: breach.limit,
        // What the cap was measured against, so the caller knows how much to
        // remove rather than only that they are over.
        current_bytes: breach.currentBytes,
      }
    );
  }

  if (breach.reason === 'unpriced_usage') {
    return new DomainError(
      'QUOTA_UNENFORCEABLE',
      `Cost quota ${breach.quotaId} cannot be enforced: the current window metered usage but priced none of it.`,
      {
        quota_id: breach.quotaId,
        metric: breach.metric,
        limit: breach.limit,
        window: breach.window,
        // The operator's next action is to price exactly these. Without them
        // the refusal reports that a price is missing but not which (#1213).
        unpriced_rows: breach.unpricedRows ?? [],
      }
    );
  }

  return new DomainError(
    'QUOTA_EXCEEDED',
    `Quota exceeded for ${breach.scope}${
      breach.scopeRef ? ` ${breach.scopeRef}` : ''
    }.`,
    {
      quota_id: breach.quotaId,
      metric: breach.metric,
      limit: breach.limit,
      window: breach.window,
      resets_at: breach.resetsAt.toISOString(),
    }
  );
};
