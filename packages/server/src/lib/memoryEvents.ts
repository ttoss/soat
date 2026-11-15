import createDebug from 'debug';
import { db } from 'src/db';
import { emitResourceEvent } from 'src/lib/eventBus';
import type { MappedMemory } from 'src/lib/memoryMapper';
import type { SoatEventTypeFor } from 'src/lib/soatEvents';

const log = createDebug('soat:memories');

/**
 * Announces a memory write. Every door that stores, changes or retracts a
 * memory emits through here, so a trigger sees a memory the same way whichever
 * door wrote it. The project is the memory store's: a memory has none of its
 * own.
 */
export const emitMemoryEvent = async (args: {
  type: SoatEventTypeFor<'memory'>;
  memoryStoreId: number;
  /** Pass when already loaded, to skip the store lookup. */
  projectId?: number;
  memory: MappedMemory;
}): Promise<void> => {
  const projectId =
    args.projectId ??
    (
      await db.MemoryStore.findByPk(args.memoryStoreId, {
        attributes: ['projectId'],
      })
    )?.projectId;
  if (projectId == null) {
    log(
      'emitMemoryEvent: no store id=%d type=%s',
      args.memoryStoreId,
      args.type
    );
    return;
  }
  log('emitMemoryEvent: type=%s memoryId=%s', args.type, args.memory.id);
  emitResourceEvent({
    type: args.type,
    projectId,
    resourceType: 'memory',
    resourceId: args.memory.id,
    data: args.memory,
  });
};
