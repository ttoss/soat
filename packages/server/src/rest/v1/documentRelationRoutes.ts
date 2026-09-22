import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  createDocumentRelation,
  deleteDocumentRelation,
  listDocumentRelations,
  readRelationType,
} from 'src/lib/documentRelations';
import { getDocument } from 'src/lib/documents';

import {
  checkDocumentPermission,
  documentsRouter as _router,
} from './documents';
import { requireAuth, resolveReadProjectIds } from './helpers';

/**
 * A document's typed edges, as a sub-resource of the document that asserts
 * them.
 *
 * Reading one is reading the document, and writing one is writing it: an edge
 * is the asserting document's own annotation, so the gates are its
 * `GetDocument` and `UpdateDocument` — the same pair its tag sub-resource
 * uses, rather than a second vocabulary for the same authority.
 */
/**
 * The document an edge is asserted by, gated for `action`. Returns null when
 * the gate already answered `403`, which the caller returns on.
 */
const gateDocument = async (args: {
  ctx: Context;
  action: string;
}): Promise<boolean> => {
  const doc = await getDocument({ id: args.ctx.params.document_id });
  if (!doc) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }
  return checkDocumentPermission(args.ctx, doc, args.action);
};

/** The caller's document scope, for resolving the other end of an edge. */
const documentScope = (ctx: Context) => {
  return resolveReadProjectIds({
    ctx,
    action: 'documents:GetDocument',
    resourceType: 'document',
  });
};

export const registerDocumentRelationRoutes = (args: {
  documentsRouter: Router<Context>;
}): void => {
  const { documentsRouter } = args;

  documentsRouter.get(
    '/documents/:document_id/relations',
    async (ctx: Context) => {
      requireAuth(ctx);

      if (!(await gateDocument({ ctx, action: 'documents:GetDocument' }))) {
        return;
      }

      ctx.body = await listDocumentRelations({
        documentId: ctx.params.document_id,
        projectIds: await documentScope(ctx),
      });
    }
  );

  documentsRouter.post(
    '/documents/:document_id/relations',
    async (ctx: Context) => {
      requireAuth(ctx);

      const body = ctx.request.body as {
        type?: unknown;
        to_document_id?: unknown;
      };

      if (!(await gateDocument({ ctx, action: 'documents:UpdateDocument' }))) {
        return;
      }

      ctx.status = 201;
      ctx.body = await createDocumentRelation({
        fromDocumentId: ctx.params.document_id,
        type: readRelationType(body.type),
        toDocumentId:
          typeof body.to_document_id === 'string' ? body.to_document_id : '',
        projectIds: await documentScope(ctx),
      });
    }
  );

  documentsRouter.delete(
    '/documents/:document_id/relations/:relation_id',
    async (ctx: Context) => {
      requireAuth(ctx);

      if (!(await gateDocument({ ctx, action: 'documents:UpdateDocument' }))) {
        return;
      }

      await deleteDocumentRelation({
        documentId: ctx.params.document_id,
        relationId: ctx.params.relation_id,
        projectIds: await documentScope(ctx),
      });

      ctx.status = 204;
    }
  );
};
