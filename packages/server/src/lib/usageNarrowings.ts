import { USAGE_EVENT_DURABLE_IDS } from '@soat/postgresdb';

import type { ScopedIdResource } from './scopedIdFilters';
import { resolveEachScopedId } from './scopedIdFilters';
import type { EventFilter } from './usageAggregateSql';

/**
 * The filters a usage read accepts, and how each reaches the event table.
 *
 * Two classes. A filter naming a **resource** selects the events that recorded
 * its public id: by the indexed FK while the resource exists, and by the
 * public id stored beside it once it is deleted, so the spend of a deleted
 * agent stays selectable by that agent's id. An id no event recorded selects
 * nothing — a mistyped id never reads back as the project's whole spend. A
 * filter carrying a **value** is matched as the event recorded it and needs no
 * lookup: an unrecognised meter, model or workload source simply selects
 * nothing, which is also why `trigger_id` and `action_id` are values — the
 * event stores them denormalized so spend outlives the trigger that incurred
 * it.
 */

/** The narrowings as the caller sent them, before any are resolved. */
export type UsageNarrowings = {
  meterType?: string;
  model?: string;
  source?: string;
  triggerId?: string;
  actionId?: string;
  outcome?: string;
  sessionId?: string;
  actorId?: string;
  agentId?: string;
  aiProviderId?: string;
  orchestrationRunId?: string;
  orchestrationId?: string;
  generationId?: string;
  traceId?: string;
  toolId?: string;
  publisherProjectId?: string;
};

/**
 * Every narrowing applied, echoed back exactly as the caller sent it and
 * `null` when unset.
 *
 * Echoed because a rollup of zeros is otherwise indistinguishable from a
 * project that spent nothing, and always complete because a caller reading one
 * key must be able to tell "not filtered" from "this endpoint does not know
 * that filter". Grouped rather than spread across the response's top level: at
 * fifteen they would outnumber the figures, and a top-level `ai_provider_id`
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
  outcome: 'outcome',
  sessionId: 'session_id',
  actorId: 'actor_id',
  agentId: 'agent_id',
  aiProviderId: 'ai_provider_id',
  orchestrationRunId: 'orchestration_run_id',
  orchestrationId: 'orchestration_id',
  generationId: 'generation_id',
  traceId: 'trace_id',
  toolId: 'tool_id',
  publisherProjectId: 'publisher_project_id',
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
  | 'toolId'
  | 'traceId'
  | 'publisherProjectId';

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
  { key: 'toolId', resource: 'tool' },
  { key: 'publisherProjectId', resource: 'publisherProject' },
];

/** The rest: matched against the event's own column, no lookup. */
export const VALUE_NARROWING_KEYS = [
  'meterType',
  'model',
  'source',
  'triggerId',
  'actionId',
  'outcome',
] as const;

/** The id narrowings the event records a public id for: every one but the orchestration's. */
export type RecordedIdKey = Exclude<IdNarrowingKey, 'orchestrationId'>;

const snakeCase = (camel: string): string => {
  return camel.replace(/[A-Z]/g, (letter) => {
    return `_${letter.toLowerCase()}`;
  });
};

/**
 * Where each id narrowing's public id is recorded on the event: the model
 * attribute a Sequelize `where` keys on, and the column raw SQL compares.
 * Read off `USAGE_EVENT_DURABLE_IDS`, whose FK names are the narrowing keys.
 */
export const RECORDED_ID_COLUMNS = Object.fromEntries(
  USAGE_EVENT_DURABLE_IDS.filter((pair) => {
    return ID_NARROWINGS.some((narrowing) => {
      return narrowing.key === pair.foreignKey;
    });
  }).map((pair) => {
    return [
      pair.foreignKey,
      { attribute: pair.publicId, column: snakeCase(pair.publicId) },
    ];
  })
) as Record<RecordedIdKey, { attribute: string; column: string }>;

export type ResolvedIdNarrowings = {
  /** Narrowings naming a resource that exists, as its internal id. */
  ids: Partial<Record<IdNarrowingKey, number>>;
  /** Narrowings naming none, matched on the public id the event recorded. */
  recordedIds: Partial<Record<RecordedIdKey, string>>;
};

/**
 * The id narrowings as the event filter takes them, or `null` when the
 * orchestration named does not exist — the event records no orchestration id,
 * so there is nothing to match it against.
 */
export const resolveIdNarrowings = async (args: {
  projectIds?: number[];
  narrowings: UsageNarrowings;
}): Promise<ResolvedIdNarrowings | null> => {
  const resolved = await resolveEachScopedId({
    ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
    filters: ID_NARROWINGS.map((narrowing) => {
      return {
        key: narrowing.key,
        resource: narrowing.resource,
        publicId: args.narrowings[narrowing.key],
      };
    }),
  });

  const result: ResolvedIdNarrowings = { ids: {}, recordedIds: {} };
  for (const { key } of ID_NARROWINGS) {
    const publicId = args.narrowings[key];
    if (publicId === undefined) continue;
    const id = resolved[key];
    if (typeof id === 'number') {
      result.ids[key] = id;
    } else if (key === 'orchestrationId') {
      return null;
    } else {
      result.recordedIds[key] = publicId;
    }
  }
  return result;
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
