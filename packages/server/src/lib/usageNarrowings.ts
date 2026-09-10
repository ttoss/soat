import type { ScopedIdResource } from './scopedIdFilters';
import { resolveScopedIds } from './scopedIdFilters';
import type { EventFilter } from './usageAggregateSql';

/**
 * The filters a usage read accepts, and how each reaches the event table.
 *
 * Two classes, because the two fail differently. A filter naming a **resource**
 * is resolved against the caller's project, and one naming nothing there
 * empties the answer — a mistyped id must never read back as the project's
 * whole spend. A filter carrying a **value** is matched as the event recorded
 * it and needs no lookup: an unrecognised meter, model or workload source
 * simply selects nothing, which is also why `trigger_id` and `action_id` are
 * values — the event stores them denormalized so spend outlives the trigger
 * that incurred it (#1265).
 */

/** The narrowings as the caller sent them, before any are resolved. */
export type UsageNarrowings = {
  meterType?: string;
  model?: string;
  source?: string;
  triggerId?: string;
  actionId?: string;
  sessionId?: string;
  actorId?: string;
  agentId?: string;
  aiProviderId?: string;
  orchestrationRunId?: string;
  orchestrationId?: string;
  generationId?: string;
  traceId?: string;
};

/**
 * Every narrowing applied, echoed back exactly as the caller sent it and
 * `null` when unset.
 *
 * Echoed because a rollup of zeros is otherwise indistinguishable from a
 * project that spent nothing, and always complete because a caller reading one
 * key must be able to tell "not filtered" from "this endpoint does not know
 * that filter". Grouped rather than spread across the response's top level: at
 * thirteen they would outnumber the figures, and a top-level `ai_provider_id`
 * would sit beside a per-group `ai_provider_id` that means something else.
 */
export type UsageAggregateFilters = {
  [K in keyof UsageNarrowings as WireName<K>]: string | null;
};

// The wire name of each narrowing: snake_case, as every other field on the
// response. Spelled out rather than derived, so the contract is greppable.
const WIRE_NAMES = {
  meterType: 'meter_type',
  model: 'model',
  source: 'source',
  triggerId: 'trigger_id',
  actionId: 'action_id',
  sessionId: 'session_id',
  actorId: 'actor_id',
  agentId: 'agent_id',
  aiProviderId: 'ai_provider_id',
  orchestrationRunId: 'orchestration_run_id',
  orchestrationId: 'orchestration_id',
  generationId: 'generation_id',
  traceId: 'trace_id',
} as const satisfies Record<keyof UsageNarrowings, string>;

type WireName<K extends keyof UsageNarrowings> = (typeof WIRE_NAMES)[K];

type IdNarrowingKey =
  | 'actorId'
  | 'agentId'
  | 'aiProviderId'
  | 'generationId'
  | 'orchestrationId'
  | 'orchestrationRunId'
  | 'sessionId'
  | 'traceId';

// Which table each id narrowing resolves against.
const ID_NARROWINGS: ReadonlyArray<{
  key: IdNarrowingKey;
  resource: ScopedIdResource;
}> = [
  { key: 'sessionId', resource: 'session' },
  { key: 'actorId', resource: 'actor' },
  { key: 'agentId', resource: 'agent' },
  { key: 'aiProviderId', resource: 'aiProvider' },
  { key: 'orchestrationRunId', resource: 'orchestrationRun' },
  { key: 'orchestrationId', resource: 'orchestration' },
  { key: 'generationId', resource: 'generation' },
  { key: 'traceId', resource: 'trace' },
];

/** The rest: matched against the event's own column, no lookup. */
export const VALUE_NARROWING_KEYS = [
  'meterType',
  'model',
  'source',
  'triggerId',
  'actionId',
] as const;

/**
 * The id narrowings as the event filter takes them, or `null` when one names
 * nothing in this project — which empties the rollup rather than dropping the
 * filter, since a total the caller reads as one session's must never turn out
 * to be the project's.
 */
export const resolveIdNarrowings = async (args: {
  projectId: number;
  narrowings: UsageNarrowings;
}): Promise<Partial<Record<IdNarrowingKey, number>> | null> => {
  return resolveScopedIds({
    projectIds: [args.projectId],
    filters: ID_NARROWINGS.map((narrowing) => {
      return {
        key: narrowing.key,
        resource: narrowing.resource,
        publicId: args.narrowings[narrowing.key],
      };
    }),
  });
};

// The narrowings that need no resolution, dropping the ones left unset so the
// filter carries only what the caller asked for.
export const valueNarrowings = (
  args: UsageNarrowings
): Partial<EventFilter> => {
  const values: Partial<EventFilter> = {};
  for (const key of VALUE_NARROWING_KEYS) {
    const value = args[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
};

export const echoedFilters = (args: UsageNarrowings): UsageAggregateFilters => {
  const entries = Object.entries(WIRE_NAMES) as Array<
    [keyof UsageNarrowings, string]
  >;
  return Object.fromEntries(
    entries.map(([key, wireName]) => {
      return [wireName, args[key] ?? null];
    })
  ) as UsageAggregateFilters;
};
