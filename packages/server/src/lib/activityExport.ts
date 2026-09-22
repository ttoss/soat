import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';
import {
  type ActivityFilters,
  buildActivityWhere,
  mapActivityEntry,
} from 'src/lib/activity';
import {
  afterCursorWhere,
  EXPORT_ORDER,
  streamNdjson,
} from 'src/lib/ndjsonExport';

const log = createDebug('soat:activity');

/**
 * Streams a project's activity feed as NDJSON, in the read shape the listing
 * returns and narrowed by the same filters.
 *
 * Oldest first, where the feed itself reads newest first: a feed answers "what
 * just happened" and an export is read start to end, so the order that suits
 * one is the wrong one for the other.
 */
export const streamActivityNdjson = (
  filters: ActivityFilters
): AsyncGenerator<string> => {
  log('streamActivityNdjson: projects=%d', filters.projectIds.length);

  const where = buildActivityWhere(filters);

  return streamNdjson({
    findBatch: ({ after, limit }) => {
      const resume = afterCursorWhere(after);
      return db.ActivityEntry.findAll({
        where: resume ? { [Op.and]: [where, resume] } : where,
        include: [{ model: db.Project, as: 'project' }],
        order: EXPORT_ORDER,
        limit,
      });
    },
    map: mapActivityEntry,
  });
};
