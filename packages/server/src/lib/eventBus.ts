import { EventEmitter } from 'node:events';

import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:eventBus');

export interface SoatEvent {
  type: string;
  projectId: number;
  projectPublicId: string;
  resourceType: string;
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

export const onEvent = (handler: (event: SoatEvent) => void) => {
  eventBus.on('soat:event', handler);
};

/**
 * Emits a resource lifecycle event, owning the three parts of the envelope that
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
export const emitResourceEvent = (args: {
  type: string;
  projectId: number;
  /** Pass when already loaded, to skip the lookup. */
  projectPublicId?: string;
  resourceType: string;
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
        'emitResourceEvent: dropping %s for %s — project lookup failed: %o',
        args.type,
        args.resourceId,
        error
      );
    });
};

export { eventBus };
