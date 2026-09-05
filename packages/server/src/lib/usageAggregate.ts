import createDebug from 'debug';

import { DomainError } from '../errors';
import type { PaginatedResult } from './pagination';
import { resolvePagination } from './pagination';
import { sumComponentCostUsd, sumQuantities } from './priceCompute';
import type {
  ComponentSum,
  EventFilter,
  UsageGroupBy,
} from './usageAggregateSql';
import {
  bucketKeyOf,
  countGroups,
  loadGroupPage,
  loadPageComponents,
  loadWindowComponents,
  loadWindowTotals,
  USAGE_GROUP_BY,
} from './usageAggregateSql';

const log = createDebug('soat:usage');

export type { UsageGroupBy } from './usageAggregateSql';
export { USAGE_GROUP_BY } from './usageAggregateSql';

const isGroupBy = (value: string): value is UsageGroupBy => {
  return (USAGE_GROUP_BY as readonly string[]).includes(value);
};

// What makes the rollup uniform over meter types: the token fields describe
// only `llm_tokens`, so without a per-component quantity an infra meter would
// report an all-zero bucket despite carrying real amounts.
export type UsageAggregateComponent = {
  component: string;
  unit: string;
  quantity: number;
  cost_usd: number | null;
};

export type UsageAggregateTotals = {
  cost_usd: number | null;
  // Events measured in the bucket. The one figure a "how many" question can
  // read without walking the groups; on `totals` it counts the whole window.
  event_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  // Every component measured in the bucket, sorted by `component` then `unit`
  // so the rollup is stable regardless of event order.
  components: UsageAggregateComponent[];
};

export type UsageAggregateGroup = UsageAggregateTotals & {
  // The group's value in the chosen dimension: a model id, meter type, agent /
  // run public id, or a `YYYY-MM-DD` UTC day. Null when the dimension does not
  // apply to an event (e.g. a standalone generation grouped by `run`).
  key: string | null;
  // The provider that served the bucket's model, under `group_by=model` only;
  // null on every other dimension. See `GROUP_DIMENSIONS`.
  ai_provider_id: string | null;
};

/** The wire shape of an aggregate — this value is a response body, not internal state. */
export type UsageAggregate = {
  project_id: string;
  from: string | null;
  to: string | null;
  group_by: UsageGroupBy;
  // The meter-type filter applied, echoed back; null when unfiltered.
  meter_type: string | null;
  // Paginated: a dimension like `run` has one entry per run in the window, so
  // the collection is walked rather than returned whole. `total` is the number
  // of distinct buckets, which answers "how many" without reading a page.
  groups: PaginatedResult<UsageAggregateGroup>;
  // Always the whole `[from, to]` window, never the page above it. A
  // page-scoped total read against an allowance would understate spend by
  // whatever the caller did not page through.
  totals: UsageAggregateTotals;
};

// Postgres has already summed exactly; routing the single result back through
// the shared formatter keeps the emitted scale identical to the row-by-row
// rollup's, without re-accumulating in floating point.
const decimalToCost = (sum: string | null): number | null => {
  const total = sumComponentCostUsd([sum]);
  return total === null ? null : Number(total);
};

const toAggregateComponent = (sum: ComponentSum): UsageAggregateComponent => {
  return {
    component: sum.component,
    unit: sum.unit,
    quantity: sumQuantities([sum.quantity]),
    cost_usd: decimalToCost(sum.costUsd),
  };
};

// Token counts are reconstructed from the component sums the same way the
// receipt does: the `input_tokens` component holds uncached input, so full
// prompt tokens are input + cached. Summed across units, since a component name
// is what names a token kind.
const quantityOf = (sums: ComponentSum[], component: string): number => {
  const matching = sums
    .filter((sum) => {
      return sum.component === component;
    })
    .map((sum) => {
      return sum.quantity;
    });
  return matching.length === 0 ? 0 : sumQuantities(matching);
};

const totalsFrom = (args: {
  costUsd: string | null;
  eventCount: number;
  components: ComponentSum[];
}): UsageAggregateTotals => {
  const cached = quantityOf(args.components, 'cached_tokens');
  return {
    cost_usd: decimalToCost(args.costUsd),
    event_count: args.eventCount,
    input_tokens: quantityOf(args.components, 'input_tokens') + cached,
    output_tokens: quantityOf(args.components, 'output_tokens'),
    cached_tokens: cached,
    reasoning_tokens: quantityOf(args.components, 'reasoning_tokens'),
    components: args.components.map(toAggregateComponent).sort((a, b) => {
      return (
        a.component.localeCompare(b.component) || a.unit.localeCompare(b.unit)
      );
    }),
  };
};

// Parses an optional ISO timestamp bound, throwing VALIDATION_FAILED on a
// malformed value so a typo is a bad request rather than a silent full scan.
const parseBound = (value: string | undefined, label: string): Date | null => {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${label} must be a valid ISO timestamp (got '${value}').`
    );
  }
  return date;
};

const parseGroupBy = (value: string | undefined): UsageGroupBy => {
  if (value === undefined || !isGroupBy(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `group_by must be one of ${USAGE_GROUP_BY.join(', ')} (got '${
        value ?? ''
      }').`
    );
  }
  return value;
};

/**
 * Rolls a project's usage up over an optional `[from, to]` window, bucketed by
 * one dimension (`model` | `ai_provider` | `agent` | `run` | `day` |
 * `meter_type` | `actor` | `session` | `source`), optionally narrowed to a
 * single `meterType`. Each group and the grand total carry an event count,
 * summed token counts, a measured `quantity` per component, and `cost_usd`
 * (null when no event in the bucket was priced).
 *
 * Aggregated by Postgres, not in memory: the window is grouped and summed in
 * SQL with one join for the chosen dimension, and only the requested page of
 * buckets is materialized. `totals` and `groups.total` describe the whole
 * window regardless of the page. `projectId` is the internal id the caller has
 * already resolved (and authorized).
 */
export const aggregateUsage = async (args: {
  projectId: number;
  projectPublicId: string;
  from?: string;
  to?: string;
  groupBy?: string;
  meterType?: string;
  limit?: number;
  offset?: number;
}): Promise<UsageAggregate> => {
  const groupBy = parseGroupBy(args.groupBy);
  const from = parseBound(args.from, 'from');
  const to = parseBound(args.to, 'to');
  const { limit, offset } = resolvePagination({
    limit: args.limit,
    offset: args.offset,
  });

  log(
    'aggregateUsage: projectId=%d groupBy=%s from=%s to=%s meterType=%s limit=%d offset=%d',
    args.projectId,
    groupBy,
    from?.toISOString() ?? null,
    to?.toISOString() ?? null,
    args.meterType ?? null,
    limit,
    offset
  );

  const filter: EventFilter = {
    projectId: args.projectId,
    from,
    to,
    meterType: args.meterType,
  };

  // Independent aggregates over the same indexed window — none reads another's
  // result, so they go in one round trip's worth of wall clock.
  const [
    windowTotals,
    windowComponents,
    groupCount,
    groupRows,
    pageComponents,
  ] = await Promise.all([
    loadWindowTotals(filter),
    loadWindowComponents(filter),
    countGroups({ filter, groupBy }),
    loadGroupPage({ filter, groupBy, limit, offset }),
    loadPageComponents({ filter, groupBy, limit, offset }),
  ]);

  const groups: UsageAggregateGroup[] = groupRows.map((row) => {
    return {
      key: row.key,
      ai_provider_id: row.aiProviderId,
      ...totalsFrom({
        costUsd: row.costUsd,
        eventCount: row.eventCount,
        components: pageComponents.get(bucketKeyOf(row)) ?? [],
      }),
    };
  });

  return {
    project_id: args.projectPublicId,
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
    group_by: groupBy,
    meter_type: args.meterType ?? null,
    groups: { data: groups, total: groupCount, limit, offset },
    totals: totalsFrom({
      costUsd: windowTotals.costUsd,
      eventCount: windowTotals.eventCount,
      components: windowComponents,
    }),
  };
};
