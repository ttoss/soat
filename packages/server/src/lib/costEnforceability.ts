/**
 * Whether a window's metered cost can be compared against a ceiling at all.
 *
 * `SUM(cost_usd)` ignores nulls, so a window whose AI usage was never priced
 * sums to a number that understates real spend — and every ceiling reading it
 * passes. The quota path answers that window with `QUOTA_UNENFORCEABLE`; the
 * readers here are what let a guardrail's cost ceiling answer it too, by
 * resolving to `null` instead of a figure that cannot be trusted. A null
 * `runtime.*` operand of a `<`/`>` comparison already fails closed (#666), so
 * the refusal needs no new machinery in the evaluator.
 *
 * **The verdict reads the AI meter alone**, and `countsTowardPricingVerdict` is
 * the one definition of that, shared with `quotaEnforcement.ts` so the two
 * cannot drift. A platform meter is priced by the operator rather than by a
 * tenant's provider, and an embedding is priced from deployment configuration
 * with no price-book tier a tenant can reach (#1213) — counting either would
 * refuse a ceiling nobody in the project can make enforceable, and a project
 * that has not generated yet would be refused the very call that would price
 * the window.
 *
 * **A partly-priced window still reports its priced total.** Any priced AI
 * event clears the verdict, so the unpriced ones keep counting as zero; whether
 * that deserves its own signal is #1177's open question, not this module's.
 */

import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DEFAULT_METER_TYPE } from './priceCompute';
import { EMBEDDING_USAGE_SOURCE } from './usageEmbeddingRecording';

/** Whether an event's pricing says anything about a cost cap's enforceability. */
export const countsTowardPricingVerdict = (event: {
  meterType: string;
  source: string | null;
}): boolean => {
  return (
    event.meterType === DEFAULT_METER_TYPE &&
    event.source !== EMBEDDING_USAGE_SOURCE
  );
};

/**
 * The cost recorded by the events `where` selects, or `null` when they metered
 * AI usage and priced none of it.
 *
 * The total spans every meter — a priced platform meter is real spend and
 * belongs under the ceiling — while only the AI meter decides the verdict. The
 * rows are read and summed here rather than aggregated in SQL so the verdict
 * and the sum apply one predicate to one set of rows, which is what keeps this
 * identical to the quota path's reading of the same window.
 */
const enforceableCostUsd = async (args: {
  where: Record<string | symbol, unknown>;
}): Promise<number | null> => {
  const events = await db.UsageEvent.findAll({
    where: args.where,
    attributes: ['costUsd', 'meterType', 'source'],
  });

  const metered = events.filter((event) => {
    return countsTowardPricingVerdict(event);
  });
  const blackedOut =
    metered.length > 0 &&
    metered.every((event) => {
      return event.costUsd == null;
    });
  if (blackedOut) return null;

  return events.reduce((sum, event) => {
    return event.costUsd == null ? sum : sum + Number(event.costUsd);
  }, 0);
};

/** A project's rolling window, for `runtime.usage.cost_usd_*`. */
export const windowedEnforceableCostUsd = async (args: {
  projectId: number;
  start: Date;
}): Promise<number | null> => {
  return enforceableCostUsd({
    where: { projectId: args.projectId, createdAt: { [Op.gte]: args.start } },
  });
};

/** One orchestration run's cumulative spend, for `runtime.usage.orchestration_run_cost_usd`. */
export const orchestrationRunEnforceableCostUsd = async (args: {
  runInternalId: number;
}): Promise<number | null> => {
  return enforceableCostUsd({
    where: { orchestrationRunId: args.runInternalId },
  });
};
