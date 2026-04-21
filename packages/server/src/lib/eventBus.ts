import { EventEmitter } from 'node:events';

import { db } from '../db';

export interface SoatEvent {
  type: string;
  projectId: number;
  projectPublicId: string;
  resourceType: string;
  resourceId: string;
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

export { eventBus };
