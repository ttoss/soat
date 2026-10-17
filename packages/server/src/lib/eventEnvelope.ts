import createDebug from 'debug';

import type { SoatEvent } from './eventBus';

const log = createDebug('soat:eventEnvelope');

/**
 * One bus event as a consumer outside the bus receives it: the body of a
 * webhook delivery and the input of an `event` trigger firing, so a trigger
 * reads the same fields a webhook subscriber does.
 *
 * `id` is the emission's identity. Every delivery, redelivery and firing of
 * one event carries the same value, which makes it the key a consumer dedupes
 * on. `data` is copied as a value; nothing reads or rewrites a key of it.
 */
export type EventEnvelope = {
  id: string;
  event: string;
  project_id: string;
  resource_type: string;
  resource_id: string;
  data: Record<string, unknown>;
  timestamp: string;
};

export const buildEventEnvelope = (args: {
  event: SoatEvent;
}): EventEnvelope => {
  const { event } = args;
  log('buildEventEnvelope: id=%s type=%s', event.id, event.type);
  return {
    id: event.id,
    event: event.type,
    project_id: event.projectPublicId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    data: event.data,
    timestamp: event.timestamp,
  };
};

/**
 * The event id a stored envelope carries, read back from a delivery's
 * persisted payload. `undefined` for a payload stored without one.
 */
export const envelopeEventId = (args: {
  payload: object;
}): string | undefined => {
  const { payload } = args;
  return 'id' in payload && typeof payload.id === 'string'
    ? payload.id
    : undefined;
};
