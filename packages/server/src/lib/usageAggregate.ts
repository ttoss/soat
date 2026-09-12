import createDebug from 'debug';

import { DomainError } from '../errors';
import type { PaginatedResult } from './pagination';
import { resolvePagination } from './pagination';
import { sumComponentCostUsd, sumQuantities } from './priceCompute';
import type {
  ComponentSum,
  EventFilter,
  UsageDistinctCounts,
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
import type { UsageAggregateFilters, UsageNarrowings } from './usageNarrowings';
import {
  echoedFilters,
  resolveIdNarrowings,
  valueNarrowings,
} from './usageNarrowings';
import type { UsageTotals } from './usageReceipt';

const log = createDebug('soat:usage');

export type { UsageDistinctCounts, UsageGroupBy } from './usageAggregateSql';
export { USAGE_GROUP_BY } from './usageAggregateSql';
export type { UsageAggregateFilters, UsageNarrowings } from './usageNarrowings';

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

/** The figures every bucket carries — one group, or the whole window. */
export type UsageAggregateBucket = {
  cost_usd: number | null;
  // Events measured in the bucket. On `totals` it counts the whole window.
  event_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  // Every component measured in the bucket, sorted by `component` then `unit`
  // so the rollup is stable regardless of event order.
  components: UsageAggregateComponent[];
};

/**
 * The window's bucket, plus the distinct-entity counters when the caller asked
 * for them.
 *
 * `distinct` is on `totals` only: filling it per group would mean a
 * `COUNT(DISTINCT)` per bucket on the page query, and leaving it declared on
 * the shared shape would have groups carrying a field they cannot fill.
 */
export type UsageAggregateTotals = UsageAggregateBucket & {
  distinct?: UsageDistinctCounts;
};

export type UsageAggregateGroup = UsageAggregateBucket & {
  // The group's value in the chosen dimension: a model id, meter type, agent /
  // orchestration run public id, or a `YYYY-MM-DD` UTC day. Null when the
  // dimension does not apply to an event (e.g. a standalone generation
  // grouped by `orchestration_run`).
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
  // Null when the caller asked for no bucketing: `totals` answers "what did
  // this cost" without forcing a dimension it does not care about, and
  // `groups` is then an empty page.
  group_by: UsageGroupBy | null;
  filters: UsageAggregateFilters;
  // Paginated: a dimension like `orchestration_run` has one entry per run in
  // the window, so the collection is walked rather than returned whole.
  // `total` is the number of distinct buckets — bucket cardinality, never an
  // entity count (#1216): read `totals.distinct` for that.
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
}): UsageAggregateBucket => {
  const cached = quantityOf(args.components, 'cached_tokens');
  const cacheWrite = quantityOf(args.components, 'cache_write_tokens');
  return {
    cost_usd: decimalToCost(args.costUsd),
    event_count: args.eventCount,
    input_tokens:
      quantityOf(args.components, 'input_tokens') + cached + cacheWrite,
    output_tokens: quantityOf(args.components, 'output_tokens'),
    cached_tokens: cached,
    cache_write_tokens: cacheWrite,
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

// Optional: "what did agent X cost" wants `totals`, and requiring a dimension
// there only forces the caller to pick one it will discard. A value that names
// no dimension is still a 400 — that is a typo, not an omission.
const parseGroupBy = (value: string | undefined): UsageGroupBy | null => {
  if (value === undefined || value === '') return null;
  if (!isGroupBy(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `group_by must be one of ${USAGE_GROUP_BY.join(', ')} (got '${value}').`
    );
  }
  return value;
};

// The only `include` value: opt-in for the distinct-entity counters, which
// cost one sort of the window per key. Rejected rather than ignored, so a typo
// is a bad request instead of a silently missing field the caller then reads
// as zero.
const USAGE_INCLUDE_DISTINCT = 'distinct';

const parseInclude = (value: string | undefined): boolean => {
  if (value === undefined || value === '') return false;
  const requested = value.split(',').map((part) => {
    return part.trim();
  });
  for (const part of requested) {
    if (part !== USAGE_INCLUDE_DISTINCT) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `include must be '${USAGE_INCLUDE_DISTINCT}' (got '${part}').`
      );
    }
  }
  return true;
};

// The rollup a narrowing that matched nothing answers with: the window and the
// filters the caller sent, and no measured anything.
const emptyAggregate = (args: {
  projectPublicId: string;
  from: Date | null;
  to: Date | null;
  groupBy: UsageGroupBy | null;
  filters: UsageAggregateFilters;
  limit: number;
  offset: number;
}): UsageAggregate => {
  return {
    project_id: args.projectPublicId,
    from: args.from ? args.from.toISOString() : null,
    to: args.to ? args.to.toISOString() : null,
    group_by: args.groupBy,
    filters: args.filters,
    groups: { data: [], total: 0, limit: args.limit, offset: args.offset },
    totals: totalsFrom({ costUsd: null, eventCount: 0, components: [] }),
  };
};

/**
 * The bucketed page of a rollup: its buckets, their component sums, and how
 * many buckets the window holds in total.
 *
 * Three of the five reads behind a rollup, and the three a dimensionless
 * request skips entirely — `group_by` is what they are all keyed on.
 */
const loadGroups = async (args: {
  filter: EventFilter;
  groupBy: UsageGroupBy | null;
  limit: number;
  offset: number;
}): Promise<PaginatedResult<UsageAggregateGroup>> => {
  const { filter, groupBy, limit, offset } = args;
  if (groupBy === null) {
    return { data: [], total: 0, limit, offset };
  }

  const [groupCount, groupRows, pageComponents] = await Promise.all([
    countGroups({ filter, groupBy }),
    loadGroupPage({ filter, groupBy, limit, offset }),
    loadPageComponents({ filter, groupBy, limit, offset }),
  ]);

  const data: UsageAggregateGroup[] = groupRows.map((row) => {
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

  return { data, total: groupCount, limit, offset };
};

/**
 * The reads behind a rollup, and their shaping, once the filter is settled.
 *
 * Independent aggregates over the same indexed window — none reads another's
 * result, so they go in one round trip's worth of wall clock.
 */
const buildAggregate = async (args: {
  filter: EventFilter;
  groupBy: UsageGroupBy | null;
  includeDistinct: boolean;
  projectPublicId: string;
  filters: UsageAggregateFilters;
  limit: number;
  offset: number;
}): Promise<UsageAggregate> => {
  const { filter, groupBy, limit, offset } = args;

  const [windowTotals, windowComponents, groups] = await Promise.all([
    loadWindowTotals(filter, { distinct: args.includeDistinct }),
    loadWindowComponents(filter),
    loadGroups({ filter, groupBy, limit, offset }),
  ]);

  return {
    project_id: args.projectPublicId,
    from: filter.from ? filter.from.toISOString() : null,
    to: filter.to ? filter.to.toISOString() : null,
    group_by: groupBy,
    filters: args.filters,
    groups,
    totals: {
      ...totalsFrom({
        costUsd: windowTotals.costUsd,
        eventCount: windowTotals.eventCount,
        components: windowComponents,
      }),
      ...(windowTotals.distinct === null
        ? {}
        : { distinct: windowTotals.distinct }),
    },
  };
};

/**
 * The token/cost figures over an arbitrary slice of the event table, in the
 * `UsageTotals` shape a receipt and an orchestration run already report.
 *
 * Two indexed aggregates rather than a read of every line item: the caller is a
 * record's own `usage` field, so the cost has to track the number of figures it
 * answers with, not the number of events behind them.
 */
export const rollUpUsageTotals = async (
  filter: EventFilter
): Promise<UsageTotals> => {
  const [windowTotals, components] = await Promise.all([
    loadWindowTotals(filter),
    loadWindowComponents(filter),
  ]);
  const bucket = totalsFrom({
    costUsd: windowTotals.costUsd,
    eventCount: windowTotals.eventCount,
    components,
  });
  return {
    cost_usd: bucket.cost_usd,
    input_tokens: bucket.input_tokens,
    output_tokens: bucket.output_tokens,
    cached_tokens: bucket.cached_tokens,
    cache_write_tokens: bucket.cache_write_tokens,
    reasoning_tokens: bucket.reasoning_tokens,
  };
};

/**
 * Rolls a project's usage up over an optional `[from, to]` window, optionally
 * bucketed by one dimension (`model` | `ai_provider` | `agent` |
 * `orchestration_run` | `day` | `meter_type` | `actor` | `session` | `source`)
 * and narrowed by any combination of the thirteen filters in
 * `UsageNarrowings`. Each group and the grand total carry an event count,
 * summed token counts, a measured `quantity` per component, and `cost_usd`
 * (null when no event in the bucket was priced). `include=distinct` adds
 * `totals.distinct`, the distinct-entity counters a "how many" question reads.
 *
 * Narrowings intersect, and apply to the whole rollup — every bucket, the
 * window totals and the distinct counters alike. The eight that name a
 * resource are public ids resolved against this project; one naming nothing
 * here empties the rollup, so a mistyped id reads as zero rather than as the
 * project's whole spend. The other five are matched as the event recorded
 * them.
 *
 * Aggregated by Postgres, not in memory: the window is grouped and summed in
 * SQL with one join for the chosen dimension, and only the requested page of
 * buckets is materialized. `totals` and `groups.total` describe the whole
 * window regardless of the page. `projectId` is the internal id the caller has
 * already resolved (and authorized).
 */
export const aggregateUsage = async (
  args: UsageNarrowings & {
    projectId: number;
    projectPublicId: string;
    from?: string;
    to?: string;
    groupBy?: string;
    include?: string;
    limit?: number;
    offset?: number;
  }
): Promise<UsageAggregate> => {
  const groupBy = parseGroupBy(args.groupBy);
  const includeDistinct = parseInclude(args.include);
  const from = parseBound(args.from, 'from');
  const to = parseBound(args.to, 'to');
  const { limit, offset } = resolvePagination({
    limit: args.limit,
    offset: args.offset,
  });

  const filters = echoedFilters(args);

  log(
    'aggregateUsage: projectId=%d groupBy=%s from=%s to=%s filters=%o limit=%d offset=%d',
    args.projectId,
    groupBy,
    from?.toISOString() ?? null,
    to?.toISOString() ?? null,
    filters,
    limit,
    offset
  );

  const ids = await resolveIdNarrowings({
    projectId: args.projectId,
    narrowings: args,
  });

  if (!ids) {
    return emptyAggregate({
      projectPublicId: args.projectPublicId,
      from,
      to,
      groupBy,
      filters,
      limit,
      offset,
    });
  }

  return buildAggregate({
    filter: {
      projectId: args.projectId,
      from,
      to,
      ...valueNarrowings(args),
      ...ids,
    },
    groupBy,
    includeDistinct,
    projectPublicId: args.projectPublicId,
    filters,
    limit,
    offset,
  });
};
