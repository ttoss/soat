import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { getDocument } from 'src/lib/documents';
import {
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
} from 'src/lib/documentVersions';
import { withdrawDocument } from 'src/lib/documentWithdrawal';

import type { ProjectOwned } from './helpers';
import { requireAuth, writePreconditionOf } from './helpers';

/**
 * A document's history: its archived versions, the withdrawal that takes it
 * out of every default read, and the restore that brings it back.
 *
 * Registered onto the documents router rather than a router of its own, so
 * the paths stay under `/documents/{document_id}` and the module's own
 * permission check is the one that guards them.
 */

type DocumentForPermission = {
  id: string;
  path?: string;
  tags?: Record<string, string>;
} & ProjectOwned;

type RegisterArgs = {
  documentsRouter: Router<Context>;
  checkDocumentPermission: (
    ctx: Context,
    doc: DocumentForPermission,
    action: string
  ) => Promise<boolean>;
};

/** A version path segment, refused rather than coerced when it is not one. */
const parseVersionParam = (raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${raw}' is not a version number.`
    );
  }
  return Number(raw);
};

export const registerDocumentVersionRoutes = (args: RegisterArgs) => {
  const { documentsRouter, checkDocumentPermission } = args;

  /**
   * Loads the document a history route names and checks the caller may act on
   * it. Both halves throw — `404` when it is gone, `403` when the action is
   * not allowed — so a caller reaching the line after this has been cleared.
   */
  const requireDocument = async (ctx: Context, action: string) => {
    const doc = await getDocument({ id: ctx.params.document_id });
    if (!doc) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
    }
    await checkDocumentPermission(ctx, doc, action);
  };

  documentsRouter.post(
    '/documents/:document_id/withdraw',
    async (ctx: Context) => {
      requireAuth(ctx);
      await requireDocument(ctx, 'documents:WithdrawDocument');

      const body = ctx.request.body as { version_label?: unknown };

      ctx.body = await withdrawDocument({
        id: ctx.params.document_id,
        versionLabel:
          typeof body?.version_label === 'string'
            ? body.version_label
            : undefined,
        expectedVersion: writePreconditionOf(ctx),
        createdByUserId: ctx.authUser?.id,
      });
    }
  );

  documentsRouter.get(
    '/documents/:document_id/versions',
    async (ctx: Context) => {
      requireAuth(ctx);
      await requireDocument(ctx, 'documents:ListDocumentVersions');

      ctx.body = await listDocumentVersions({
        documentId: ctx.params.document_id,
        limit: ctx.query.limit
          ? parseInt(ctx.query.limit as string, 10)
          : undefined,
        offset: ctx.query.offset
          ? parseInt(ctx.query.offset as string, 10)
          : undefined,
      });
    }
  );

  documentsRouter.get(
    '/documents/:document_id/versions/:version',
    async (ctx: Context) => {
      requireAuth(ctx);
      await requireDocument(ctx, 'documents:GetDocumentVersion');

      ctx.body = await getDocumentVersion({
        documentId: ctx.params.document_id,
        version: parseVersionParam(ctx.params.version),
      });
    }
  );

  documentsRouter.post(
    '/documents/:document_id/versions/:version/restore',
    async (ctx: Context) => {
      requireAuth(ctx);
      await requireDocument(ctx, 'documents:RestoreDocumentVersion');

      const body = ctx.request.body as { label?: unknown };

      ctx.body = await restoreDocumentVersion({
        documentId: ctx.params.document_id,
        version: parseVersionParam(ctx.params.version),
        label: typeof body?.label === 'string' ? body.label : undefined,
        createdByUserId: ctx.authUser?.id,
      });
    }
  );
};
