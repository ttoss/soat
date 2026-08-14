import { EventEmitter } from 'node:events';

import createDebug from 'debug';

import { db } from '../db';
import type {
  SoatEventName,
  SoatEventType,
  SoatEventTypeFor,
  SoatResourceType,
} from './soatEvents';
import { asCustomEventName } from './soatEvents';

/**
 * The envelope's own vocabulary, re-exported so an emit site imports the names
 * it may use from the same module it emits through.
 */
export type {
  CustomEventName,
  SoatEventName,
  SoatEventType,
  SoatEventTypeFor,
  SoatResourceType,
} from './soatEvents';

const log = createDebug('soat:eventBus');

export interface SoatEvent {
  /**
   * A registered platform event name, or — for an orchestration `emit_event`
   * node — the name the template author wrote. See `soatEvents.ts`.
   */
  type: SoatEventName;
  projectId: number;
  projectPublicId: string;
  resourceType: SoatResourceType;
  resourceId: string;
  /**
   * The resource payload, carried as an opaque value: the bus never reads a key
   * of it, and neither does {@link emitResourceEvent}.
   */
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Look up the public ID for an internal project ID.
 * Returns an empty string when the project cannot be found.
 */
export const resolveProjectPublicId = async (args: {
  projectId: number;
}): Promise<string> => {
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
  });
  return project?.publicId ?? '';
};

class SoatEventBus extends EventEmitter {}

const eventBus = new SoatEventBus();

export const emitEvent = (event: SoatEvent) => {
  eventBus.emit('soat:event', event);
};

/**
 * Subscribes to the bus. Pass `types` to declare which events the subscriber
 * cares about; omit it to receive every event.
 *
 * The filter is here rather than in each subscriber because the names it takes
 * are checked against the registry: a renamed event breaks the subscription at
 * compile time, where a hand-rolled `if (event.type === '…')` just stopped
 * matching. A subscriber that genuinely needs everything — the webhook
 * dispatcher, which forwards user-authored orchestration events too — omits
 * `types` and says so.
 */
export const onEvent = (args: {
  types?: readonly SoatEventType[];
  handler: (event: SoatEvent) => void;
}) => {
  const { types, handler } = args;

  if (!types) {
    eventBus.on('soat:event', handler);
    return;
  }

  const wanted = new Set<string>(types);

  eventBus.on('soat:event', (event: SoatEvent) => {
    if (wanted.has(event.type)) handler(event);
  });
};

/**
 * The shared dispatch behind {@link emitResourceEvent} and
 * {@link emitCustomEvent}: it owns the three parts of the envelope that
 * every emit site used to re-derive: the `timestamp`, the project public-id
 * lookup when the caller does not already hold one, and — the part that
 * mattered — the `.catch()` on that lookup.
 *
 * Seventeen sites resolved the public id through a floating promise with no
 * rejection handler (#903). `resolveProjectPublicId` performs a real DB read, so
 * a transient failure there became an unhandled rejection, which by default
 * terminates the process — long after the write it belonged to had committed.
 * An event is best-effort by design: a failed lookup is logged and dropped, and
 * the operation that produced it still succeeds.
 *
 * `data` is taken and forwarded as an opaque value; nothing here inspects a key
 * of it, so this introduces no key-walking surface (`case-convention.md`).
 */
const emitEnvelope = (args: {
  type: SoatEventName;
  projectId: number;
  projectPublicId?: string;
  resourceType: SoatResourceType;
  resourceId: string;
  data: object;
}): void => {
  const emit = (projectPublicId: string) => {
    emitEvent({
      type: args.type,
      projectId: args.projectId,
      projectPublicId,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      // The payload is a mapper's own return type. TypeScript will not assign
      // such a type to an index signature even though every key is a string;
      // asserting it here, once, is what keeps the 38 call sites free of the
      // `as unknown as Record<string, unknown>` double casts they used to carry
      // (forbidden by the repo's type-safety rule). Nothing reads a key of it.
      data: args.data as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
  };

  if (args.projectPublicId !== undefined) {
    emit(args.projectPublicId);
    return;
  }

  void resolveProjectPublicId({ projectId: args.projectId })
    .then(emit)
    .catch((error: unknown) => {
      log(
        'emitEnvelope: dropping %s for %s — project lookup failed: %o',
        args.type,
        args.resourceId,
        error
      );
    });
};

/**
 * Emits a registered platform event.
 *
 * `type` is drawn from the registry entry for the `resourceType` given, so an
 * event name that does not belong to that resource — a typo, a rename that
 * missed a site, an event attached to the wrong resource — is a type error here
 * rather than a subscription that silently never matches again.
 */
export const emitResourceEvent = <R extends SoatResourceType>(args: {
  type: SoatEventTypeFor<R>;
  projectId: number;
  /** Pass when already loaded, to skip the lookup. */
  projectPublicId?: string;
  resourceType: R;
  resourceId: string;
  data: object;
}): void => {
  emitEnvelope(args);
};

/**
 * Emits an event whose name SOAT does not own: an orchestration `emit_event`
 * node emits whatever the template author wrote, and a webhook subscribed to
 * that name delivers it. That name cannot be a registered literal, so this is
 * the deliberate escape hatch from {@link emitResourceEvent}'s union.
 *
 * It is deliberately the *only* one. A platform emit site that reached for this
 * would put an unregistered event on the bus with no compiler complaint and no
 * row in the generated webhook reference, so
 * `tests/unit/tests/lib/eventTypeContract.test.ts` pins the single call site.
 */
export const emitCustomEvent = (args: {
  type: string;
  projectId: number;
  projectPublicId?: string;
  resourceType: SoatResourceType;
  resourceId: string;
  data: object;
}): void => {
  emitEnvelope({ ...args, type: asCustomEventName({ name: args.type }) });
};

export { eventBus };
