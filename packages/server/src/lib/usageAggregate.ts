import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { sumComponentCostUsd, sumQuantities } from './priceCompute';

const log = createDebug('soat:usage');

// `day` buckets on the UTC calendar day; the rest on the matching column. Work
// with no end user behind it collapses into the `null` bucket rather than being
// dropped, so the groups still sum to the project total.
export const USAGE_GROUP_BY = [
  'model',
  'ai_provider',
  'agent',
  'run',
  'day',
  'meter_type',
  'actor',
  'session',
  'source',
] as const;

export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

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
  // null on every other dimension. See `providerForEvent`.
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
  groups: UsageAggregateGroup[];
  totals: UsageAggregateTotals;
};

type EventWithComponents = InstanceType<(typeof db)['UsageEvent']> & {
  agent?: InstanceType<(typeof db)['Agent']> | null;
  aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
  run?: InstanceType<(typeof db)['OrchestrationRun']> | null;
  actor?: InstanceType<(typeof db)['Actor']> | null;
  session?: InstanceType<(typeof db)['Session']> | null;
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

// Exhaustive over `UsageGroupBy`, so a new dimension without an extractor is a
// type error rather than a silent `null` bucket.
const GROUP_KEY_EXTRACTORS: {
  [K in UsageGroupBy]: (event: EventWithComponents) => string | null;
} = {
  model: (event) => {
    return event.model;
  },
  meter_type: (event) => {
    return event.meterType;
  },
  // What the spend was incurred *for*: `eval` / `eval_judge` mark verification
  // spend, so it can be priced apart from the traffic serving real users.
  // Ordinary traffic carries no source and buckets under the single null key.
  source: (event) => {
    return event.source;
  },
  // The provider instance the spend was billed against — a routed generation's
  // serving target, or the agent's pinned provider.
  ai_provider: (event) => {
    return event.aiProvider?.publicId ?? null;
  },
  agent: (event) => {
    return event.agent?.publicId ?? null;
  },
  run: (event) => {
    return event.run?.publicId ?? null;
  },
  actor: (event) => {
    return event.actor?.publicId ?? null;
  },
  session: (event) => {
    return event.session?.publicId ?? null;
  },
  // Immutable events carry only createdAt; bucket on its UTC calendar day.
  day: (event) => {
    return event.createdAt.toISOString().slice(0, 10);
  },
};

/**
 * The provider whose model the event names, under `group_by=model` only.
 *
 * A model id does not identify the model on its own: one project can hold two
 * providers serving byte-identical strings (a resold model and a tenant's own
 * credential for the same vendor), and a consumer that presents its own model
 * names cannot translate a bucket it cannot attribute. So the model dimension
 * buckets on (model, ai_provider_id) — `key` keeps its shape and this sibling
 * names the provider, instead of one merged bucket whose provider is
 * unanswerable. Events with no provider (a compute or storage meter) keep
 * collapsing into a single null-provider bucket.
 */
const providerForEvent = (
  event: EventWithComponents,
  groupBy: UsageGroupBy
): string | null => {
  return groupBy === 'model' ? (event.aiProvider?.publicId ?? null) : null;
};

// The event's value in the chosen dimension. Null when the column is not set on
// the event (grouped into a `null` bucket, not dropped).
const groupKeyForEvent = (
  event: EventWithComponents,
  groupBy: UsageGroupBy
): string | null => {
  return GROUP_KEY_EXTRACTORS[groupBy](event);
};

// Keyed by `component`+`unit`, never name alone: a quantity is additive only
// within one unit. Collected as the DECIMAL strings they arrive as and summed
// exactly at the end, so a fractional measure accumulates no float drift.
type ComponentAccumulator = {
  component: string;
  unit: string;
  quantities: string[];
  costs: Array<string | null>;
};

type Accumulator = EventTokens & {
  costs: Array<string | null>;
  components: Map<string, ComponentAccumulator>;
};

const emptyAccumulator = (): Accumulator => {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    costs: [],
    components: new Map(),
  };
};

const addComponents = (acc: Accumulator, event: EventWithComponents): void => {
  for (const component of event.components ?? []) {
    const key = `${component.component}|${component.unit}`;
    let entry = acc.components.get(key);
    if (!entry) {
      entry = {
        component: component.component,
        unit: component.unit,
        quantities: [],
        costs: [],
      };
      acc.components.set(key, entry);
    }
    entry.quantities.push(String(component.quantity));
    entry.costs.push(component.costUsd);
  }
};

const addEvent = (acc: Accumulator, event: EventWithComponents): void => {
  const tokens = eventTokens(event);
  acc.inputTokens += tokens.inputTokens;
  acc.outputTokens += tokens.outputTokens;
  acc.cachedTokens += tokens.cachedTokens;
  acc.reasoningTokens += tokens.reasoningTokens;
  acc.costs.push(event.costUsd);
  addComponents(acc, event);
};

const numberOrNull = (value: string | null): number | null => {
  return value === null ? null : Number(value);
};

// Sorted by component then unit, so the array is stable across calls no matter
// what order the events arrived in.
const finalizeComponents = (
  components: Map<string, ComponentAccumulator>
): UsageAggregateComponent[] => {
  return [...components.values()]
    .map((entry) => {
      return {
        component: entry.component,
        unit: entry.unit,
        quantity: sumQuantities(entry.quantities),
        cost_usd: numberOrNull(sumComponentCostUsd(entry.costs)),
      };
    })
    .sort((a, b) => {
      return (
        a.component.localeCompare(b.component) || a.unit.localeCompare(b.unit)
      );
    });
};

const finalizeTotals = (acc: Accumulator): UsageAggregateTotals => {
  return {
    cost_usd: numberOrNull(sumComponentCostUsd(acc.costs)),
    input_tokens: acc.inputTokens,
    output_tokens: acc.outputTokens,
    cached_tokens: acc.cachedTokens,
    reasoning_tokens: acc.reasoningTokens,
    components: finalizeComponents(acc.components),
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
  const buckets = new Map<
    string,
    { key: string | null; aiProviderId: string | null; acc: Accumulator }
  >();
  const total = emptyAccumulator();

  for (const event of events) {
    const key = groupKeyForEvent(event, groupBy);
    const aiProviderId = providerForEvent(event, groupBy);
    const bucketKey = JSON.stringify([key, aiProviderId]);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { key, aiProviderId, acc: emptyAccumulator() };
      buckets.set(bucketKey, bucket);
    }
    addEvent(bucket.acc, event);
    addEvent(total, event);
  }

  return {
    groups: [...buckets.values()].map((bucket) => {
      return {
        key: bucket.key,
        ai_provider_id: bucket.aiProviderId,
        ...finalizeTotals(bucket.acc),
      };
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

// `meterType` is deliberately unvalidated — a free-form column the meters
// listing filters the same way, so an unknown type yields an empty rollup
// rather than a 400.
const eventsWhere = (args: {
  projectId: number;
  from: Date | null;
  to: Date | null;
  meterType?: string;
}): Record<string | symbol, unknown> => {
  const where: Record<string | symbol, unknown> = {
    projectId: args.projectId,
  };
  const createdAt = createdAtWhere(args.from, args.to);
  if (createdAt) where.createdAt = createdAt;
  if (args.meterType !== undefined) where.meterType = args.meterType;
  return where;
};

/**
 * Rolls a project's usage up over an optional `[from, to]` window, bucketed by
 * one dimension (`model` | `ai_provider` | `agent` | `run` | `day` |
 * `meter_type` | `actor` | `session` | `source`), optionally narrowed to a
 * single `meterType`. Each group and the
 * grand total carry summed token counts, a measured `quantity` per component,
 * and `cost_usd` (null when no event in the bucket was priced). Scans the
 * `(project_id, created_at)`-indexed events with their component rows and
 * aggregates in memory. `projectId` is the internal id the caller has already
 * resolved (and authorized).
 */
export const aggregateUsage = async (args: {
  projectId: number;
  projectPublicId: string;
  from?: string;
  to?: string;
  groupBy?: string;
  meterType?: string;
}): Promise<UsageAggregate> => {
  const groupBy = parseGroupBy(args.groupBy);
  const from = parseBound(args.from, 'from');
  const to = parseBound(args.to, 'to');

  log(
    'aggregateUsage: projectId=%d groupBy=%s from=%s to=%s meterType=%s',
    args.projectId,
    groupBy,
    from?.toISOString() ?? null,
    to?.toISOString() ?? null,
    args.meterType ?? null
  );

  const events: EventWithComponents[] = await db.UsageEvent.findAll({
    where: eventsWhere({
      projectId: args.projectId,
      from,
      to,
      meterType: args.meterType,
    }),
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.AiProvider, as: 'aiProvider' },
      { model: db.OrchestrationRun, as: 'run' },
      { model: db.Actor, as: 'actor' },
      { model: db.Session, as: 'session' },
      { model: db.UsageComponent, as: 'components' },
    ],
    order: [['createdAt', 'ASC']],
  });

  const { groups, totals } = bucketEvents(events, groupBy);

  return {
    project_id: args.projectPublicId,
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
    group_by: groupBy,
    meter_type: args.meterType ?? null,
    groups,
    totals,
  };
};
