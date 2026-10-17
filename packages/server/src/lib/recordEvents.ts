import createDebug from 'debug';

import {
  emitResourceEvent,
  recordDroppedEvent,
  resolveProjectPublicId,
  type SoatEventTypeFor,
  type SoatResourceType,
} from './eventBus';
import { retryTransient } from './transientRetry';

const log = createDebug('soat:events');

/**
 * Retries `operation`, and drops the event at `stage` once the retries are
 * spent; `undefined` then means "dropped".
 */
const readOrDrop = async <T>(args: {
  stage: 'project_lookup' | 'record_lookup';
  type: string;
  resourceId: string;
  operation: () => Promise<T>;
}): Promise<T | undefined> => {
  try {
    return await retryTransient({
      label: `emitLoadedRecordEvent.${args.stage}`,
      operation: args.operation,
    });
  } catch (error) {
    recordDroppedEvent({
      stage: args.stage,
      type: args.type,
      resourceId: args.resourceId,
      error,
    });
    return undefined;
  }
};

/**
 * Emits an event whose `data` is a record the emit site does not hold: it is
 * read through `load`, the module's own `GET` reader, after the write the
 * event announces. `facts` ride beside the record and never replace one of
 * its keys.
 *
 * Never throws, because the write it follows has committed: a read that
 * outlives its retries drops the event through `recordDroppedEvent`.
 */
export const emitLoadedRecordEvent = async <
  R extends SoatResourceType,
  T extends object,
>(args: {
  type: SoatEventTypeFor<R>;
  projectId: number;
  projectPublicId?: string;
  resourceType: R;
  resourceId: string;
  load: (scope: { projectPublicId: string }) => T | Promise<T>;
  facts?: Record<string, unknown> & { [K in keyof T]?: never };
  timestamp?: string;
}): Promise<void> => {
  log('emitLoadedRecordEvent: type=%s id=%s', args.type, args.resourceId);

  const projectPublicId =
    args.projectPublicId ??
    (await readOrDrop({
      stage: 'project_lookup',
      type: args.type,
      resourceId: args.resourceId,
      operation: () => {
        return resolveProjectPublicId({ projectId: args.projectId });
      },
    }));
  if (projectPublicId === undefined) return;

  const record = await readOrDrop({
    stage: 'record_lookup',
    type: args.type,
    resourceId: args.resourceId,
    operation: async () => {
      return args.load({ projectPublicId });
    },
  });
  if (record === undefined) return;

  emitResourceEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    data: { ...record, ...args.facts },
    timestamp: args.timestamp,
  });
};
