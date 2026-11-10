import { DomainError } from '../errors';
import {
  type EventFilterArgs,
  isEventPatternList,
  validateEventFilter,
} from './eventMatching';

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
  if (!isEventPatternList(args.events) || args.events.length === 0) {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'events is required for event triggers: a non-empty list of event type patterns.'
    );
  }
  validateEventFilter(args);
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
