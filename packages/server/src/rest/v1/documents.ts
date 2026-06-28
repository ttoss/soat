/* eslint-disable max-lines */
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createDocument,
  deleteDocument,
  enqueueDocumentIngestion,
  getDocument,
  getDocumentStatus,
  getDocumentTags,
  listDocuments,
  reingestDocument,
  updateDocument,
  updateDocumentTags,
} from 'src/lib/documents';
import { buildSrn } from 'src/lib/iam';
import { compilePolicy } from 'src/lib/policyCompiler';
import { rejectUnknownFields } from 'src/lib/requestValidation';

import { checkAuth, resolveWriteProjectId } from './helpers';

const documentsRouter = new Router<Context>();

/**
 * Build context object from document tags for permission evaluation
 */
const buildDocumentContext = (doc: {
  tags?: Record<string, unknown>;
}): Record<string, string> => {
  const context: Record<string, string> = { 'soat:ResourceType': 'document' };
  if (doc.tags) {
    for (const [k, v] of Object.entries(doc.tags)) {
      context[`soat:ResourceTag/${k}`] = String(v);
    }
  }
  return context;
};

/**
 * Build SRN resources array (id and path-based) for permission evaluation
 */
const buildDocumentResources = (
  doc: {
    id: string;
    path?: string;
    projectId?: string;
  },
  projectPublicId: string
): string[] => {
  const srn = buildSrn({
    projectPublicId,
    resourceType: 'document',
    resourceId: doc.id,
  });
  const resources: string[] = [srn];
  if (doc.path) {
    resources.push(
      buildSrn({
        projectPublicId,
        resourceType: 'document',
        resourceId: doc.path,
      })
    );
  }
  return resources;
};

/**
 * Check if user is allowed to perform action on document
 * Returns false if not allowed (after setting ctx.status to 403)
 */
const checkDocumentPermission = async (
  ctx: Context,
  doc: {
    id: string;
    path?: string;
    projectId?: string;
    tags?: Record<string, unknown>;
  },
  action: string
): Promise<boolean> => {
  const context = buildDocumentContext(doc);
  const resources = buildDocumentResources(doc, doc.projectId!);
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: doc.projectId!,
    action,
    resources,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
  }
  return allowed;
};

documentsRouter.get('/documents', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await ctx.authUser!.resolveProjectIds({
    projectPublicId,
    action: 'documents:ListDocuments',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  // Compile SQL-level policy filter when a specific project is requested
  if (projectPublicId) {
    const policies = await ctx.authUser!.getPolicies(projectPublicId);
    const { where: policyWhere, hasAccess } = compilePolicy({
      policies,
      action: 'documents:ListDocuments',
      resourceType: 'document',
      projectPublicId,
    });
    if (!hasAccess) {
      ctx.body = {
        data: [],
        total: 0,
        limit: limit ?? 50,
        offset: offset ?? 0,
      };
      return;
    }
    ctx.body = await listDocuments({ projectIds, policyWhere, limit, offset });
    return;
  }

  ctx.body = await listDocuments({ projectIds, limit, offset });
});

documentsRouter.get('/documents/:document_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:GetDocument'))) {
    return;
  }

  ctx.body = doc;
});

documentsRouter.post('/documents', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  rejectUnknownFields({
    method: 'post',
    path: '/documents',
    body: ctx.request.body as Record<string, unknown>,
  });

  const body = ctx.request.body as {
    projectId?: string;
    content: string;
    path?: string;
    filename?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
    chunkStrategy?: 'page' | 'whole' | 'size';
    chunkSize?: number;
    chunkOverlap?: number;
  };

  if (!body.content) {
    ctx.status = 400;
    ctx.body = { error: 'content is required' };
    return;
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'documents:CreateDocument',
  });
  if (targetProjectId === null) return;

  const doc = await createDocument({
    projectId: Number(targetProjectId),
    content: body.content,
    path: body.path,
    filename: body.filename,
    title: body.title,
    metadata: body.metadata,
    tags: body.tags,
    chunkStrategy: body.chunkStrategy,
    chunkSize: body.chunkSize,
    chunkOverlap: body.chunkOverlap,
  });
  ctx.status = 201;
  ctx.body = doc;
});

documentsRouter.delete('/documents/:document_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:DeleteDocument'))) {
    return;
  }

  const result = await deleteDocument({ id: ctx.params.document_id });
  if (result === null) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  ctx.status = 204;
});

documentsRouter.patch('/documents/:document_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:UpdateDocument'))) {
    return;
  }

  rejectUnknownFields({
    method: 'patch',
    path: '/documents/:document_id',
    body: ctx.request.body as Record<string, unknown>,
  });

  const body = ctx.request.body as {
    content?: string;
    title?: string;
    path?: string | null;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  };

  const updated = await updateDocument({
    id: ctx.params.document_id,
    content: body.content,
    title: body.title,
    path: body.path,
    metadata: body.metadata,
    tags: body.tags,
  });
  ctx.body = updated;
});

documentsRouter.get('/documents/:document_id/status', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const status = await getDocumentStatus({ id: ctx.params.document_id });
  if (!status) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, status, 'documents:GetDocument'))) {
    return;
  }

  // Return only the lightweight lifecycle payload — never chunk content.
  ctx.body = {
    id: status.id,
    status: status.status,
    chunkCount: status.chunkCount,
    totalChunks: status.totalChunks,
    totalPages: status.totalPages,
    progress: status.progress,
    error: status.error,
  };
});

documentsRouter.get('/documents/:document_id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:GetDocument'))) {
    return;
  }

  ctx.body = await getDocumentTags({ id: ctx.params.document_id });
});

documentsRouter.put('/documents/:document_id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:UpdateDocument'))) {
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateDocumentTags({
    id: ctx.params.document_id,
    tags,
    merge: false,
  });
});

documentsRouter.patch('/documents/:document_id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:UpdateDocument'))) {
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateDocumentTags({
    id: ctx.params.document_id,
    tags,
    merge: true,
  });
});

documentsRouter.post('/documents/ingest', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  rejectUnknownFields({
    method: 'post',
    path: '/documents/ingest',
    body: ctx.request.body as Record<string, unknown>,
  });

  const body = ctx.request.body as {
    fileId?: string;
    projectId?: string;
    pathPrefix?: string;
    tags?: Record<string, string>;
    chunkStrategy?: 'page' | 'whole' | 'size';
    chunkSize?: number;
    chunkOverlap?: number;
  };

  // Async by default; ?async=false runs synchronously and returns 201.
  const isAsync = ctx.query['async'] !== 'false';

  if (!body.fileId) {
    ctx.status = 400;
    ctx.body = { error: 'fileId is required' };
    return;
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'documents:IngestDocument',
  });
  if (targetProjectId === null) return;

  const result = await enqueueDocumentIngestion({
    fileId: body.fileId,
    projectId: Number(targetProjectId),
    pathPrefix: body.pathPrefix,
    tags: body.tags,
    chunkStrategy: body.chunkStrategy,
    chunkSize: body.chunkSize,
    chunkOverlap: body.chunkOverlap,
    async: isAsync,
  });

  ctx.status = isAsync ? 202 : 201;
  ctx.body = result;
});

documentsRouter.post('/documents/:document_id/ingest', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocumentStatus({ id: ctx.params.document_id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:IngestDocument'))) {
    return;
  }

  rejectUnknownFields({
    method: 'post',
    path: '/documents/:document_id/ingest',
    body: ctx.request.body as Record<string, unknown>,
  });

  const body = ctx.request.body as {
    chunkStrategy?: 'page' | 'whole' | 'size';
    chunkSize?: number;
    chunkOverlap?: number;
  };

  // Async by default; ?async=false runs synchronously and returns 201.
  const isAsync = ctx.query['async'] !== 'false';

  const result = await reingestDocument({
    id: ctx.params.document_id,
    chunkStrategy: body.chunkStrategy,
    chunkSize: body.chunkSize,
    chunkOverlap: body.chunkOverlap,
    async: isAsync,
  });

  ctx.status = isAsync ? 202 : 201;
  ctx.body = result;
});

export { documentsRouter };
