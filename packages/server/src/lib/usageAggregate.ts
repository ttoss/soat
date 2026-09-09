import createDebug from 'debug';

import { db } from '../db';
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
import type { UsageTotals } from './usageReceipt';

const log = createDebug('soat:usage');

export type { UsageDistinctCounts, UsageGroupBy } from './usageAggregateSql';
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

/** The figures every bucket carries — one group, or the whole window. */
export type UsageAggregateBucket = {
  cost_usd: number | null;
  // Events measured in the bucket. On `totals` it counts the whole window.
  event_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
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
  group_by: UsageGroupBy;
  // The meter-type filter applied, echoed back; null when unfiltered.
  meter_type: string | null;
  // The end-user narrowings applied, echoed back; null when unfiltered. Echoed
  // because a rollup of zeros is otherwise indistinguishable from a project
  // that spent nothing.
  session_id: string | null;
  actor_id: string | null;
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

/**
 * Resolves an end-user narrowing (`session_id` / `actor_id`) to the internal id
 * the event table keys on, scoped to the project the rollup is for.
 *
 * `undefined` means "not asked for"; `null` means "asked for, and no such
 * resource in this project".
 */
const resolveNarrowing = async (args: {
  projectId: number;
  publicId: string | undefined;
  find: (where: {
    publicId: string;
    projectId: number;
  }) => Promise<{ id?: number } | null>;
}): Promise<number | null | undefined> => {
  if (args.publicId === undefined) return undefined;
  const row = await args.find({
    publicId: args.publicId,
    projectId: args.projectId,
  });
  return row?.id ?? null;
};

/**
 * Both end-user narrowings as the event filter takes them, or `null` when one
 * names nothing in this project — which empties the rollup rather than dropping
 * the filter, since a total the caller reads as one session's must never turn
 * out to be the project's.
 */
const resolveEndUserFilter = async (args: {
  projectId: number;
  sessionId?: string;
  actorId?: string;
}): Promise<Pick<EventFilter, 'actorId' | 'sessionId'> | null> => {
  const [sessionId, actorId] = await Promise.all([
    resolveNarrowing({
      projectId: args.projectId,
      publicId: args.sessionId,
      find: (where) => {
        return db.Session.findOne({ where });
      },
    }),
    resolveNarrowing({
      projectId: args.projectId,
      publicId: args.actorId,
      find: (where) => {
        return db.Actor.findOne({ where });
      },
    }),
  ]);

  if (sessionId === null || actorId === null) return null;

  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(actorId === undefined ? {} : { actorId }),
  };
};

/** The narrowings echoed back on the response, exactly as the caller sent them. */
type EchoedFilters = Pick<
  UsageAggregate,
  'actor_id' | 'meter_type' | 'session_id'
>;

const echoedFilters = (args: {
  meterType?: string;
  sessionId?: string;
  actorId?: string;
}): EchoedFilters => {
  return {
    meter_type: args.meterType ?? null,
    session_id: args.sessionId ?? null,
    actor_id: args.actorId ?? null,
  };
};

// The rollup a narrowing that matched nothing answers with: the window and the
// filters the caller sent, and no measured anything.
const emptyAggregate = (args: {
  projectPublicId: string;
  from: Date | null;
  to: Date | null;
  groupBy: UsageGroupBy;
  echoed: EchoedFilters;
  limit: number;
  offset: number;
}): UsageAggregate => {
  return {
    project_id: args.projectPublicId,
    from: args.from ? args.from.toISOString() : null,
    to: args.to ? args.to.toISOString() : null,
    group_by: args.groupBy,
    ...args.echoed,
    groups: { data: [], total: 0, limit: args.limit, offset: args.offset },
    totals: totalsFrom({ costUsd: null, eventCount: 0, components: [] }),
  };
};

/**
 * The five reads behind a rollup, and their shaping, once the filter is settled.
 *
 * Independent aggregates over the same indexed window — none reads another's
 * result, so they go in one round trip's worth of wall clock.
 */
const buildAggregate = async (args: {
  filter: EventFilter;
  groupBy: UsageGroupBy;
  includeDistinct: boolean;
  projectPublicId: string;
  echoed: EchoedFilters;
  limit: number;
  offset: number;
}): Promise<UsageAggregate> => {
  const { filter, groupBy, limit, offset } = args;

  const [
    windowTotals,
    windowComponents,
    groupCount,
    groupRows,
    pageComponents,
  ] = await Promise.all([
    loadWindowTotals(filter, { distinct: args.includeDistinct }),
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
    from: filter.from ? filter.from.toISOString() : null,
    to: filter.to ? filter.to.toISOString() : null,
    group_by: groupBy,
    ...args.echoed,
    groups: { data: groups, total: groupCount, limit, offset },
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
    reasoning_tokens: bucket.reasoning_tokens,
  };
};

/**
 * Rolls a project's usage up over an optional `[from, to]` window, bucketed by
 * one dimension (`model` | `ai_provider` | `agent` | `orchestration_run` |
 * `day` | `meter_type` | `actor` | `session` | `source`), optionally narrowed
 * to a single `meterType`, `sessionId` or `actorId`. Each group and the grand
 * total carry an event count, summed token counts, a measured `quantity` per
 * component, and `cost_usd` (null when no event in the bucket was priced).
 * `include=distinct` adds `totals.distinct`, the distinct-entity counters a
 * "how many" question reads.
 *
 * `sessionId` / `actorId` are public ids resolved against this project; one
 * naming nothing here empties the rollup, so a mistyped id reads as zero rather
 * than as the project's whole spend.
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
  sessionId?: string;
  actorId?: string;
  include?: string;
  limit?: number;
  offset?: number;
}): Promise<UsageAggregate> => {
  const groupBy = parseGroupBy(args.groupBy);
  const includeDistinct = parseInclude(args.include);
  const from = parseBound(args.from, 'from');
  const to = parseBound(args.to, 'to');
  const { limit, offset } = resolvePagination({
    limit: args.limit,
    offset: args.offset,
  });

  const echoed = echoedFilters(args);

  log(
    'aggregateUsage: projectId=%d groupBy=%s from=%s to=%s meterType=%s sessionId=%s actorId=%s limit=%d offset=%d',
    args.projectId,
    groupBy,
    from?.toISOString() ?? null,
    to?.toISOString() ?? null,
    echoed.meter_type,
    echoed.session_id,
    echoed.actor_id,
    limit,
    offset
  );

  const endUser = await resolveEndUserFilter({
    projectId: args.projectId,
    sessionId: args.sessionId,
    actorId: args.actorId,
  });

  if (!endUser) {
    return emptyAggregate({
      projectPublicId: args.projectPublicId,
      from,
      to,
      groupBy,
      echoed,
      limit,
      offset,
    });
  }

  return buildAggregate({
    filter: {
      projectId: args.projectId,
      from,
      to,
      meterType: args.meterType,
      ...endUser,
    },
    groupBy,
    includeDistinct,
    projectPublicId: args.projectPublicId,
    echoed,
    limit,
    offset,
  });
};
