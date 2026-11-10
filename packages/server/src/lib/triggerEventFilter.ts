import { DomainError } from '../errors';
import type { SoatEvent } from './eventBus';
import { matchesEvent } from './eventMatching';
import { matchesPattern } from './iam';
import { SOAT_EVENT_TYPES } from './soatEvents';
import {
  matchesStructuredFilter,
  readStructuredFilter,
} from './structuredFilter';

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
 * Validates one of an event trigger's `events` patterns: `*`, `prefix.*`, or an
 * exact event name — the grammar {@link matchesEvent} already matches.
 *
 * Beyond syntax it enforces the **namespace rule**: a pattern whose first
 * segment names a registered platform namespace must resolve to at least one
 * registered event, so `documents.ingsted` is rejected at write time.
 *
 * A pattern in an *unknown* namespace (`orders.shipped`) is accepted, because
 * an orchestration `emit_event` node emits names SOAT does not own and
 * subscribing to one is the point of this trigger type. The cost is that a typo
 * in a custom name is only visible as a subscription that never matches — the
 * same position webhook subscriptions are in.
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
 * Which events fire an event trigger: a type matching any `events` item, a
 * resource matching any `eventResources` item (`null` is any resource in the
 * project), and `data` matching `eventData`.
 */
export type TriggerEventFilter = {
  events: readonly string[] | null;
  eventResources: readonly string[] | null;
  eventData: Record<string, unknown> | null;
};

const refuse = (message: string): never => {
  throw new DomainError('VALIDATION_FAILED', message);
};

/**
 * `events` as a write carries it. `event_pattern` is the single-pattern
 * spelling of the same list, so it names `[event_pattern]`; sending both is
 * ambiguous.
 */
export const readTriggerEvents = (args: {
  events?: string[] | null;
  eventPattern?: string | null;
}): string[] | null | undefined => {
  if (args.eventPattern === undefined) return args.events;
  if (args.events !== undefined) {
    return refuse('Send events or event_pattern, not both.');
  }
  return args.eventPattern === null ? null : [args.eventPattern];
};

const isStringList = (value: unknown): value is string[] => {
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
  if (!isStringList(value)) {
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
 * The event filter's invariants: `events` is required for an event trigger,
 * and an event filter field is refused on any other type.
 */
export const validateTriggerEventFilter = (args: {
  type: string;
  events?: unknown;
  eventResources?: unknown;
  eventData?: unknown;
}): void => {
  const present = (value: unknown) => {
    return value !== undefined && value !== null;
  };
  if (args.type !== 'event') {
    const field = (
      [
        ['events', args.events],
        ['event_resources', args.eventResources],
        ['event_data', args.eventData],
      ] as const
    ).find(([, value]) => {
      return present(value);
    });
    if (field) {
      throw new DomainError(
        'TRIGGER_ACTION_NOT_ALLOWED',
        `${field[0]} is only valid for event triggers.`
      );
    }
    return;
  }
  if (!isStringList(args.events) || args.events.length === 0) {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'events is required for event triggers: a non-empty list of event type patterns.'
    );
  }
  for (const pattern of args.events) validateEventPattern(pattern);
  if (present(args.eventResources)) {
    validateEventResources(args.eventResources);
  }
  readStructuredFilter({ name: 'event_data', value: args.eventData });
};

/** The SRN an event is about, the value `event_resources` patterns match. */
export const eventSrn = (event: SoatEvent): string => {
  return `srn:${event.projectPublicId}:${event.resourceType}:${event.resourceId}`;
};

/** Whether one event passes the trigger's filter. */
export const matchesTriggerEventFilter = (args: {
  filter: TriggerEventFilter;
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

/** An event trigger's filter, as lib args carry it. */
export type EventFilterArgs = {
  events?: string[] | null;
  eventResources?: string[] | null;
  eventData?: Record<string, unknown> | null;
};

/** The filter columns a new trigger stores. */
export const storedEventFilter = (args: EventFilterArgs) => {
  return {
    events: args.events ?? null,
    eventResources: args.eventResources ?? null,
    eventData: args.eventData ?? null,
  };
};

/** The event filter an update leaves: each field sent, else the stored one. */
export const effectiveEventFilter = (params: {
  trigger: {
    events: string[] | null;
    eventResources: string[] | null;
    eventData: Record<string, unknown> | null;
  };
  args: EventFilterArgs;
}): EventFilterArgs => {
  const { trigger, args } = params;
  return {
    events: args.events !== undefined ? args.events : trigger.events,
    eventResources:
      args.eventResources !== undefined
        ? args.eventResources
        : trigger.eventResources,
    eventData:
      args.eventData !== undefined ? args.eventData : trigger.eventData,
  };
};
