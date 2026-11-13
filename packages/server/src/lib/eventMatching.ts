import { DomainError } from '../errors';
import { resolveAttachedPolicySet } from './attachedPolicies';
import { recordDroppedEvent, type SoatEvent } from './eventBus';
import { EVENT_READ_ACTIONS } from './eventReadActions';
import { matchesPattern } from './iam';
import { createPolicySetsIsAllowed } from './permissions';
import { SOAT_EVENT_TYPES } from './soatEvents';
import {
  matchesStructuredFilter,
  readStructuredFilter,
} from './structuredFilter';
import { retryTransient } from './transientRetry';

/**
 * The event filter every bus subscriber that declares *which* events it wants
 * shares — event triggers and webhook subscriptions — so a field never means
 * something slightly different in one of them.
 */

/** Whether an event type matches any of `*`, `prefix.*` or an exact name. */
export const matchesEvent = (args: {
  patterns: readonly string[];
  eventType: string;
}): boolean => {
  return args.patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern === args.eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return args.eventType.startsWith(prefix + '.');
    }
    return false;
  });
};

/**
 * The first segment of every registered platform event name (`documents`,
 * `agents`, `quotas`, …). A pattern whose namespace is one of these is claiming
 * to subscribe to a platform event, and is therefore checkable.
 */
const REGISTERED_NAMESPACES = new Set(
  SOAT_EVENT_TYPES.map((type) => {
    return type.split('.')[0];
  })
);

const REGISTERED_EVENTS = new Set<string>(SOAT_EVENT_TYPES);

/** `a`, `a.b`, `a.b.c` — dot-separated non-empty segments, no wildcard. */
const EVENT_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;

const invalidPattern = (pattern: string, why: string): DomainError => {
  return new DomainError(
    'INVALID_EVENT_PATTERN',
    `Invalid events item '${pattern}': ${why}`,
    { event: pattern }
  );
};

/**
 * Validates one `events` pattern: `*`, `prefix.*`, or an exact event name.
 *
 * A pattern whose first segment names a registered platform namespace must
 * resolve to at least one registered event, so `documents.ingsted` is refused.
 * A pattern in an unknown namespace (`orders.shipped`) is accepted: an
 * orchestration `emit_event` node emits names the platform does not own.
 */
export const validateEventPattern = (pattern: string): void => {
  if (pattern === '*') return;

  const isPrefix = pattern.endsWith('.*');
  const name = isPrefix ? pattern.slice(0, -2) : pattern;

  if (!EVENT_NAME.test(name)) {
    throw invalidPattern(
      pattern,
      "expected '*', 'prefix.*', or an event name like 'documents.ingested'."
    );
  }

  const namespace = name.split('.')[0];
  if (!REGISTERED_NAMESPACES.has(namespace)) return;

  const matches = isPrefix
    ? SOAT_EVENT_TYPES.some((type) => {
        return type.startsWith(name + '.');
      })
    : REGISTERED_EVENTS.has(name);

  if (!matches) {
    throw invalidPattern(
      pattern,
      `'${namespace}' is a platform event namespace and no registered event matches.`
    );
  }
};

/**
 * Which events a subscriber receives: a type matching any `events` item, a
 * resource matching any `eventResources` item (`null` is any resource in the
 * project), and `data` matching `eventData`.
 */
export type EventFilter = {
  events: readonly string[] | null;
  eventResources: readonly string[] | null;
  eventData: Record<string, unknown> | null;
};

/** The filter as lib args carry it: `undefined` not sent, `null` cleared. */
export type EventFilterArgs = {
  events?: string[] | null;
  eventResources?: string[] | null;
  eventData?: Record<string, unknown> | null;
};

/** The filter columns a new subscriber stores. */
export const storedEventFilter = (args: EventFilterArgs) => {
  return {
    events: args.events ?? null,
    eventResources: args.eventResources ?? null,
    eventData: args.eventData ?? null,
  };
};

const refuse = (message: string): never => {
  throw new DomainError('VALIDATION_FAILED', message);
};

export const isEventPatternList = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === 'string' && item.length > 0;
    })
  );
};

/** An SRN pattern: `*`, or `srn:<project>:<type>:<id>` with IAM wildcards. */
const SRN_PATTERN = /^srn:[^:]+:[^:]+:[^:]+$/;

const validateEventResources = (value: unknown): void => {
  if (!isEventPatternList(value)) {
    return refuse('event_resources must be a list of SRN patterns.');
  }
  for (const pattern of value) {
    if (pattern !== '*' && !SRN_PATTERN.test(pattern)) {
      refuse(
        `Invalid event_resources item '${pattern}': expected '*' or 'srn:<project>:<type>:<id>'.`
      );
    }
  }
};

/**
 * Validates the filter fields a write sends; `undefined` is a field not sent,
 * `null` one cleared. Whether `events` is required is the caller's rule.
 */
export const validateEventFilter = (args: {
  events?: unknown;
  eventResources?: unknown;
  eventData?: unknown;
}): void => {
  if (args.events !== undefined && args.events !== null) {
    if (!isEventPatternList(args.events) || args.events.length === 0) {
      refuse('events must be a non-empty list of event type patterns.');
    }
    for (const pattern of args.events as string[]) {
      validateEventPattern(pattern);
    }
  }
  if (args.eventResources !== undefined && args.eventResources !== null) {
    validateEventResources(args.eventResources);
  }
  readStructuredFilter({ name: 'event_data', value: args.eventData });
};

/** The SRN an event is about, the value `event_resources` patterns match. */
export const eventSrn = (event: SoatEvent): string => {
  return `srn:${event.projectPublicId}:${event.resourceType}:${event.resourceId}`;
};

/** Whether one event passes the filter, before the read guard. */
export const matchesEventFilter = (args: {
  filter: EventFilter;
  event: SoatEvent;
}): boolean => {
  const { filter, event } = args;
  if (!matchesEvent({ patterns: filter.events ?? [], eventType: event.type })) {
    return false;
  }
  const srn = eventSrn(event);
  if (
    filter.eventResources !== null &&
    !filter.eventResources.some((pattern) => {
      return matchesPattern({ pattern, value: srn });
    })
  ) {
    return false;
  }
  return matchesStructuredFilter({
    filter: readStructuredFilter({
      name: 'event_data',
      value: filter.eventData,
    }),
    data: event.data,
  });
};

/**
 * Whether `policyIds` may read the resource the event is about: a subscriber
 * never learns of a resource its identity cannot see.
 */
export const mayReadEventResource = (args: {
  policyIds: readonly string[] | null;
  event: SoatEvent;
}): Promise<boolean> => {
  const { event } = args;
  const isAllowed = createPolicySetsIsAllowed({
    projectPublicId: event.projectPublicId,
    getSets: async () => {
      return [
        {
          principal: { type: 'caller', id: null },
          sets: [await resolveAttachedPolicySet({ policyIds: args.policyIds })],
        },
      ];
    },
  });
  return isAllowed({
    projectPublicId: event.projectPublicId,
    action: EVENT_READ_ACTIONS[event.resourceType],
    resource: eventSrn(event),
  });
};

/**
 * The filter, then the read guard against the subscriber's `policyIds`.
 *
 * Never rejects: it runs after the emitting write committed, so a policy read
 * that outlives its retries is a counted drop and the subscriber is not told.
 */
export const subscriberReceivesEvent = async (args: {
  filter: EventFilter;
  policyIds: readonly string[] | null;
  event: SoatEvent;
}): Promise<boolean> => {
  if (!matchesEventFilter({ filter: args.filter, event: args.event })) {
    return false;
  }
  try {
    return await retryTransient({
      label: 'subscriberReceivesEvent.policyLookup',
      operation: () => {
        return mayReadEventResource({
          policyIds: args.policyIds,
          event: args.event,
        });
      },
    });
  } catch (error) {
    recordDroppedEvent({
      stage: 'policy_lookup',
      type: args.event.type,
      resourceId: args.event.resourceId,
      error,
    });
    return false;
  }
};
