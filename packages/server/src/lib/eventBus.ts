import { EventEmitter } from 'node:events';

import { db } from '../db';
import { currentCausationChain } from './eventCausation';
import type {
  SoatEventName,
  SoatEventType,
  SoatEventTypeFor,
  SoatResourceType,
} from './soatEvents';
import { asCustomEventName } from './soatEvents';
import { retryTransient } from './transientRetry';

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

/**
 * The points between a committed domain write and a durable delivery row where
 * an event can still be lost, and where a failure is therefore never silent.
 *
 * Each stage is a database read or write that the pipeline retries (see
 * {@link retryTransient}); this counter records the events that did not survive
 * even that. It exists because the alternative — the `catch {}` and the
 * swallowed rejection this replaced — made a lost event indistinguishable from
 * an event nobody subscribed to.
 */
export type EventDropStage =
  | 'project_lookup'
  | 'webhook_lookup'
  | 'delivery_write'
  | 'activity_write'
  | 'trigger_lookup'
  | 'exception_file';

const droppedEvents = new Map<EventDropStage, number>();

/**
 * Records an event the pipeline could not recover, on the one path where the
 * operation that produced it has already committed and cannot be failed.
 *
 * Logged through `console.error` rather than `log`: `debug` output is disabled
 * in production, so a `debug`-only line would leave silent loss silent, which is
 * the bug (`db.ts` makes the same call for the same reason).
 */
export const recordDroppedEvent = (args: {
  stage: EventDropStage;
  type: string;
  resourceId: string;
  error: unknown;
}): void => {
  droppedEvents.set(args.stage, (droppedEvents.get(args.stage) ?? 0) + 1);
  // eslint-disable-next-line no-console
  console.error(
    `event dropped at ${args.stage}: ${args.type} (${args.resourceId})`,
    args.error
  );
};

/** How many events this process has dropped at a stage. */
export const droppedEventCount = (args: { stage: EventDropStage }): number => {
  return droppedEvents.get(args.stage) ?? 0;
};

/**
 * Runs a fire-and-forget subscriber write with {@link retryTransient}, and
 * counts the event as dropped via {@link recordDroppedEvent} only once the
 * retries are spent. Every bus subscriber's dispatch handler needs this exact
 * pairing around the write that happens after its own commit, so it is
 * written once here rather than once per subscriber (#1130).
 */
export const retryOrRecordDrop = (args: {
  stage: EventDropStage;
  label: string;
  event: Pick<SoatEvent, 'type' | 'resourceId'>;
  operation: () => Promise<unknown>;
}): void => {
  void retryTransient({ label: args.label, operation: args.operation }).catch(
    (error: unknown) => {
      recordDroppedEvent({
        stage: args.stage,
        type: args.event.type,
        resourceId: args.event.resourceId,
        error,
      });
    }
  );
};

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
  /**
   * The trigger public ids whose firings led to this event, oldest first —
   * stamped from the ambient causation scope (`eventCausation.ts`). Absent (or
   * empty) for an event a caller caused directly.
   *
   * It exists so a subscriber that *starts work* can see whether it is already
   * inside a chain it began: an event trigger refuses to extend a chain that
   * already names it, or one that has run too deep. Nothing else reads it.
   */
  causationChain?: readonly string[];
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
 * The `.catch()` fixed the crash but answered it with a drop, which made a
 * single connection blip enough to lose an event outright (#1130).
 *
 * So the lookup is retried, and only a failure that outlives the retries drops
 * the event — through {@link recordDroppedEvent}, which counts and prints it.
 * The emit stays best-effort in the sense that matters: it never fails the
 * operation that produced it.
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
  // Captured here rather than inside `emit`, so the deferred branch below
  // stamps the chain in scope at the emit *site* even if the store were ever
  // to differ by the time the project lookup resolves.
  const causationChain = currentCausationChain();

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
      causationChain,
    });
  };

  if (args.projectPublicId !== undefined) {
    emit(args.projectPublicId);
    return;
  }

  void retryTransient({
    label: 'emitEnvelope.resolveProjectPublicId',
    operation: () => {
      return resolveProjectPublicId({ projectId: args.projectId });
    },
  })
    .then(emit)
    .catch((error: unknown) => {
      // Only reachable once the retries are spent. The event is lost — there is
      // no envelope to emit without the public id, since it is what builds the
      // SRN a webhook policy is evaluated against — but it is now counted and
      // printed rather than dropped on a `debug` line nobody sees in production.
      recordDroppedEvent({
        stage: 'project_lookup',
        type: args.type,
        resourceId: args.resourceId,
        error,
      });
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
