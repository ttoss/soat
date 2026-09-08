/**
 * How much of a window's metered cost carried a price — the one definition both
 * cost readers hold, so the quota half and the guardrail half cannot disagree
 * about the same window.
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
 * the one definition of that. A platform meter is priced by the operator rather
 * than by a tenant's provider, and an embedding is priced from deployment
 * configuration with no price-book tier a tenant can reach (#1213) — counting
 * either would refuse a ceiling nobody in the project can make enforceable, and
 * a project that has not generated yet would be refused the very call that
 * would price the window. Both are held out in *both* directions: an unset
 * embedding rate meters at 0, which is a priced event, so counting it would
 * report a blacked-out window as measurable and wave through every unpriced
 * generation beside it. Their cost still lands in the total — zero or not, it
 * is real spend.
 *
 * **A partly-priced window still reports its priced total**, and gets a signal
 * rather than a refusal (#1228). That total is real spend, if incomplete, so
 * escalating on it would repeat #1201, where an over-broad fail-closed verdict
 * made a cost cap unrecoverable: the refusal blocked the very generation that
 * would have landed the first priced event. `unpricedRowsFrom` names the
 * `(provider, model, component)` rows behind the gap instead, which the quota
 * check files as a `quota_unpriced` exception.
 *
 * The gap is read at the **component** level, because `sumComponentCostUsd`
 * returns a number as soon as one component is priced: a model with an
 * input-token price and no output-token price produces an event that no
 * event-level comparison can tell from a fully priced one.
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

/** One `(provider, model, component)` a window metered and no price row covered. */
export type UnpricedRow = {
  provider: string;
  model: string;
  component: string;
};

type PricedEvent = {
  meterType: string;
  source: string | null;
  costUsd: string | null;
};

type MeteredEvent = PricedEvent & {
  provider: string;
  model: string;
  components?: Array<{
    component: string;
    quantity: string;
    billable: boolean;
    costUsd: string | null;
  }> | null;
};

const meteredAiEvents = <T extends PricedEvent>(events: T[]): T[] => {
  return events.filter((event) => {
    return countsTowardPricingVerdict(event);
  });
};

/**
 * The window metered AI usage and priced none of it, so there is no figure to
 * compare against a ceiling at all. Read at the event level: an event carrying
 * a cost is a real number however many of its components a price row missed.
 */
export const isPricingBlackout = (events: PricedEvent[]): boolean => {
  const metered = meteredAiEvents(events);
  return (
    metered.length > 0 &&
    metered.every((event) => {
      return event.costUsd == null;
    })
  );
};

/** Past this many, the answer is a price book to build rather than a row to add. */
const MAX_REPORTED_ROWS = 10;

/**
 * The rows an operator creates to close a pricing gap — the answer to *which*
 * price row is missing, which a coverage ratio would leave them hunting for.
 *
 * Two components are left out because pricing them would move no aggregate: one
 * that measured zero, and a non-billable detail. Embeddings and platform meters
 * are left out by `countsTowardPricingVerdict`, the predicate the blackout
 * verdict reads, so the carve-outs cannot diverge between the two: an embedding
 * has no price row to create at all, so naming one would send the operator to a
 * route that cannot fix it.
 */
export const unpricedRowsFrom = (events: MeteredEvent[]): UnpricedRow[] => {
  const rows = new Map<string, UnpricedRow>();
  for (const event of meteredAiEvents(events)) {
    /* istanbul ignore next -- every caller loads the components association */
    for (const component of event.components ?? []) {
      if (!component.billable) continue;
      if (component.costUsd != null) continue;
      if (Number(component.quantity) <= 0) continue;
      const row = {
        provider: event.provider,
        model: event.model,
        component: component.component,
      };
      // Keyed on the serialized triple rather than a joined string: a
      // separator no provider or model name can contain is one more thing to
      // be right about, and sorting the key still orders the rows by provider,
      // then model, then component.
      rows.set(JSON.stringify(row), row);
    }
  }

  // Sorted on the identity that deduplicated them, so the order is stable
  // without a second definition of what makes one row distinct from another.
  return [...rows.entries()]
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .slice(0, MAX_REPORTED_ROWS)
    .map(([, row]) => {
      return row;
    });
};

/** What a window's pricing covered, and what it left out. */
export type PricingCoverage = {
  /** AI events the window metered, whatever their pricing. */
  meteredEventCount: number;
  /** Of those, the ones no price row covered at all. */
  unpricedEventCount: number;
  /** Some AI usage carried no price: a whole event, or one component of a priced one. */
  hasUnpricedUsage: boolean;
  /** Nothing was priced, so the aggregate is no figure to hold a ceiling to. */
  blackedOut: boolean;
  /** The rows to price, capped at {@link MAX_REPORTED_ROWS}. */
  unpricedRows: UnpricedRow[];
};

/**
 * A window's coverage, read from the events themselves — the same rows the
 * aggregate sums, so the total, the verdict and the gap can never be describing
 * different windows.
 */
export const pricingCoverage = (events: MeteredEvent[]): PricingCoverage => {
  const metered = meteredAiEvents(events);
  const unpricedEventCount = metered.filter((event) => {
    return event.costUsd == null;
  }).length;
  const unpricedRows = unpricedRowsFrom(events);
  return {
    meteredEventCount: metered.length,
    unpricedEventCount,
    hasUnpricedUsage: unpricedEventCount > 0 || unpricedRows.length > 0,
    blackedOut: metered.length > 0 && unpricedEventCount === metered.length,
    unpricedRows,
  };
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

  if (isPricingBlackout(events)) return null;

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
