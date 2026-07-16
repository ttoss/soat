import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { sumComponentCostUsd } from './priceCompute';

const log = createDebug('soat:usage');

// The dimensions a project's usage can be rolled up by. `day` buckets on the
// UTC calendar day of the event; the rest bucket on the matching column.
export const USAGE_GROUP_BY = [
  'model',
  'agent',
  'run',
  'day',
  'meter_type',
] as const;

export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

const isGroupBy = (value: string): value is UsageGroupBy => {
  return (USAGE_GROUP_BY as readonly string[]).includes(value);
};

export type UsageAggregateTotals = {
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
};

export type UsageAggregateGroup = UsageAggregateTotals & {
  // The group's value in the chosen dimension: a model id, meter type, agent /
  // run public id, or a `YYYY-MM-DD` UTC day. Null when the dimension does not
  // apply to an event (e.g. a standalone generation grouped by `run`).
  key: string | null;
};

export type UsageAggregate = {
  projectId: string;
  from: string | null;
  to: string | null;
  groupBy: UsageGroupBy;
  groups: UsageAggregateGroup[];
  totals: UsageAggregateTotals;
};

type EventWithComponents = InstanceType<(typeof db)['UsageEvent']> & {
  agent?: InstanceType<(typeof db)['Agent']> | null;
  run?: InstanceType<(typeof db)['OrchestrationRun']> | null;
  components?: InstanceType<(typeof db)['UsageComponent']>[];
};

// Per-event token counts, reconstructed from the component rows the same way the
// receipt does: the `input_tokens` component holds uncached input, so full
// prompt tokens are input + cached.
type EventTokens = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
};

const componentQuantity = (
  event: EventWithComponents,
  component: string
): number => {
  return (event.components ?? [])
    .filter((c) => {
      return c.component === component;
    })
    .reduce((acc, c) => {
      return acc + Number(c.quantity);
    }, 0);
};

const eventTokens = (event: EventWithComponents): EventTokens => {
  const cached = componentQuantity(event, 'cached_tokens');
  return {
    inputTokens: componentQuantity(event, 'input_tokens') + cached,
    outputTokens: componentQuantity(event, 'output_tokens'),
    cachedTokens: cached,
    reasoningTokens: componentQuantity(event, 'reasoning_tokens'),
  };
};

// The event's value in the chosen dimension. Null when the column is not set on
// the event (grouped into a `null` bucket, not dropped).
const groupKeyForEvent = (
  event: EventWithComponents,
  groupBy: UsageGroupBy
): string | null => {
  switch (groupBy) {
    case 'model':
      return event.model;
    case 'meter_type':
      return event.meterType;
    case 'agent':
      return event.agent?.publicId ?? null;
    case 'run':
      return event.run?.publicId ?? null;
    case 'day':
      // Immutable events carry only createdAt; bucket on its UTC calendar day.
      return event.createdAt.toISOString().slice(0, 10);
    default:
      return null;
  }
};

type Accumulator = EventTokens & { costs: Array<string | null> };

const emptyAccumulator = (): Accumulator => {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    costs: [],
  };
};

const addEvent = (acc: Accumulator, event: EventWithComponents): void => {
  const tokens = eventTokens(event);
  acc.inputTokens += tokens.inputTokens;
  acc.outputTokens += tokens.outputTokens;
  acc.cachedTokens += tokens.cachedTokens;
  acc.reasoningTokens += tokens.reasoningTokens;
  acc.costs.push(event.costUsd);
};

const finalizeTotals = (acc: Accumulator): UsageAggregateTotals => {
  const summed = sumComponentCostUsd(acc.costs);
  return {
    costUsd: summed === null ? null : Number(summed),
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cachedTokens: acc.cachedTokens,
    reasoningTokens: acc.reasoningTokens,
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

// Buckets the events by the chosen dimension and rolls each bucket (and the
// grand total) up. A null dimension value collapses to one bucket whose
// reported `key` stays null.
const bucketEvents = (
  events: EventWithComponents[],
  groupBy: UsageGroupBy
): { groups: UsageAggregateGroup[]; totals: UsageAggregateTotals } => {
  const buckets = new Map<string, { key: string | null; acc: Accumulator }>();
  const total = emptyAccumulator();

  for (const event of events) {
    const key = groupKeyForEvent(event, groupBy);
    const bucketKey = key ?? '__null__';
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { key, acc: emptyAccumulator() };
      buckets.set(bucketKey, bucket);
    }
    addEvent(bucket.acc, event);
    addEvent(total, event);
  }

  return {
    groups: [...buckets.values()].map((bucket) => {
      return { key: bucket.key, ...finalizeTotals(bucket.acc) };
    }),
    totals: finalizeTotals(total),
  };
};

// Builds the created_at Sequelize filter for the optional [from, to] window.
const createdAtWhere = (
  from: Date | null,
  to: Date | null
): { [Op.gte]?: Date; [Op.lte]?: Date } | undefined => {
  if (!from && !to) return undefined;
  const createdAt: { [Op.gte]?: Date; [Op.lte]?: Date } = {};
  if (from) createdAt[Op.gte] = from;
  if (to) createdAt[Op.lte] = to;
  return createdAt;
};

/**
 * Rolls a project's usage up over an optional `[from, to]` window, bucketed by
 * one dimension (`model` | `agent` | `run` | `day` | `meter_type`). Each group
 * and the grand total carry summed token counts and `cost_usd` (null when no
 * event in the bucket was priced). Scans the `(project_id, created_at)`-indexed
 * events with their component rows and aggregates in memory. `projectId` is the
 * internal id the caller has already resolved (and authorized).
 */
export const aggregateUsage = async (args: {
  projectId: number;
  projectPublicId: string;
  from?: string;
  to?: string;
  groupBy?: string;
}): Promise<UsageAggregate> => {
  const groupBy = parseGroupBy(args.groupBy);
  const from = parseBound(args.from, 'from');
  const to = parseBound(args.to, 'to');

  log(
    'aggregateUsage: projectId=%d groupBy=%s from=%s to=%s',
    args.projectId,
    groupBy,
    from?.toISOString() ?? null,
    to?.toISOString() ?? null
  );

  const where: Record<string | symbol, unknown> = {
    projectId: args.projectId,
  };
  const createdAt = createdAtWhere(from, to);
  if (createdAt) where.createdAt = createdAt;

  const events: EventWithComponents[] = await db.UsageEvent.findAll({
    where,
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.OrchestrationRun, as: 'run' },
      { model: db.UsageComponent, as: 'components' },
    ],
    order: [['createdAt', 'ASC']],
  });

  const { groups, totals } = bucketEvents(events, groupBy);

  return {
    projectId: args.projectPublicId,
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
    groupBy,
    groups,
    totals,
  };
};
