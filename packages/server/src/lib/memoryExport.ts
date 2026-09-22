import createDebug from 'debug';
import { db } from 'src/db';
import { mapMemory, memoryIncludes } from 'src/lib/memoryMapper';
import { validMemoryWhere } from 'src/lib/memoryValidity';
import {
  EXPORT_ORDER,
  streamNdjson,
  whereAfterCursor,
} from 'src/lib/ndjsonExport';
import { hasPolicyConstraints } from 'src/lib/policyWhere';
import { applyTagFilter } from 'src/lib/tags';

const log = createDebug('soat:memories');

/**
 * Streams one store's memories as NDJSON, in the read shape the listing
 * returns.
 *
 * Invalidated memories are excluded unless asked for, as they are on a
 * listing: a retracted or superseded fact is not what the store currently
 * holds, and an export that carried it silently would put it back into
 * whatever reads the file.
 */
export const streamMemoriesNdjson = (args: {
  memoryStoreId: number;
  includeInvalidated?: boolean;
  tags?: Record<string, string>;
  policyWhere?: Record<string, unknown>;
}): AsyncGenerator<string> => {
  log(
    'streamMemoriesNdjson: memoryStoreId=%d includeInvalidated=%o',
    args.memoryStoreId,
    args.includeInvalidated
  );

  const where: Record<string, unknown> = {
    memoryStoreId: args.memoryStoreId,
    ...(args.includeInvalidated ? {} : validMemoryWhere()),
  };
  applyTagFilter({ where, tags: args.tags });
  if (hasPolicyConstraints(args.policyWhere)) {
    Object.assign(where, args.policyWhere);
  }

  return streamNdjson({
    findBatch: ({ after, limit }) => {
      return db.Memory.findAll({
        where: whereAfterCursor({ where, after }),
        include: memoryIncludes(),
        order: EXPORT_ORDER,
        limit,
      });
    },
    map: mapMemory,
  });
};
