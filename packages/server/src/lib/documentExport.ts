import createDebug from 'debug';

import { db } from '../db';
import { mapDocument } from './documentMapper';
import { buildDocumentQueryOptions } from './documents';
import { EXPORT_ORDER, streamNdjson, whereAfterCursor } from './ndjsonExport';

const log = createDebug('soat:documents');

/**
 * Streams a project's live documents as NDJSON, in the read shape the listing
 * returns.
 *
 * The rows are the listing's rows: the same policy `where`, the same reserved
 * `/.system/` exclusion and the same withdrawn-document exclusion, through
 * `buildDocumentQueryOptions`. An export a caller could not have listed would
 * be a second answer to who may see a document.
 */
export const streamDocumentsNdjson = (args: {
  projectIds: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policyWhere?: Record<string, any>;
  pathPrefix?: string;
}): AsyncGenerator<string> => {
  log(
    'streamDocumentsNdjson: projects=%d pathPrefix=%s',
    args.projectIds.length,
    args.pathPrefix ?? '(none)'
  );

  return streamNdjson({
    findBatch: ({ after, limit }) => {
      const { topLevelWhere, fileWhere, subQuery } = buildDocumentQueryOptions({
        projectIds: args.projectIds,
        policyWhere: args.policyWhere,
        pathPrefix: args.pathPrefix,
        metadataWhere: [],
        limit,
        offset: 0,
      });

      return db.Document.findAll({
        where: whereAfterCursor({ where: topLevelWhere, after }),
        include: [
          {
            model: db.File,
            as: 'file',
            where: fileWhere,
            include: [{ model: db.Project, as: 'project' }],
          },
        ],
        order: EXPORT_ORDER,
        subQuery,
        limit,
      });
    },
    map: mapDocument,
  });
};
