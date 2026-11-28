import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  findIngestSourceFilename,
  ingestedDocumentPath,
} from 'src/lib/documentIngestPath';
import { enqueueDocumentIngestion } from 'src/lib/documents';
import { assertNoSystemTagKeys, readTagBag } from 'src/lib/tags';
import { captureAuthority } from 'src/lib/workAuthority';

import { requireAuth } from './helpers';
import { resolvePathWriteProjectId } from './pathWriteAccess';
import { declareBodyTags } from './tagRoutes';

/**
 * `POST /documents/ingest`: files a document converted from a stored file,
 * authorized on the path it files it at.
 */
export const registerDocumentIngestRoute = (args: {
  documentsRouter: Router<Context>;
}) => {
  args.documentsRouter.post('/documents/ingest', async (ctx: Context) => {
    declareBodyTags(ctx);
    requireAuth(ctx);
    const body = ctx.request.body as {
      file_id: string;
      project_id?: string;
      path_prefix?: string;
      tags?: unknown;
      chunk_strategy?: 'page' | 'whole' | 'size';
      chunk_size?: number;
      chunk_overlap?: number;
      session_id?: string;
      actor_id?: string;
    };

    // Background by default; ?wait=true blocks and returns 201.
    const wait = ctx.query['wait'] === 'true';

    const sourceFilename = await findIngestSourceFilename({
      fileId: body.file_id,
    });
    const targetProjectId = await resolvePathWriteProjectId({
      ctx,
      projectPublicId: body.project_id,
      action: 'documents:IngestDocument',
      resourceType: 'document',
      key: () => {
        return sourceFilename === null
          ? null
          : ingestedDocumentPath({
              pathPrefix: body.path_prefix,
              filename: sourceFilename,
            });
      },
    });
    const result = await enqueueDocumentIngestion({
      authority: captureAuthority({ authUser: ctx.authUser }),
      fileId: body.file_id,
      projectId: Number(targetProjectId),
      pathPrefix: body.path_prefix,
      tags: assertNoSystemTagKeys(readTagBag(body.tags)),
      chunkStrategy: body.chunk_strategy,
      chunkSize: body.chunk_size,
      chunkOverlap: body.chunk_overlap,
      wait,
      endUser: { sessionId: body.session_id, actorId: body.actor_id },
    });

    ctx.status = wait ? 201 : 202;
    ctx.body = result;
  });
};
