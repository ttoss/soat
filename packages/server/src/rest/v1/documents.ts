import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
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
import { assertStorageQuota, contentBytes } from 'src/lib/quotaStorage';
import {
  buildResourceTagContext,
  readTagBag,
  readTagQuery,
} from 'src/lib/tags';

import type { AuthenticatedContext, ProjectOwned } from './helpers';
import {
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { registerIngestionCallbackRoute } from './ingestionCallbackRoute';
import { registerTagRoutes, type TagAccess } from './tagRoutes';

const documentsRouter = new Router<Context>();

/**
 * Build context object from document tags for permission evaluation
 */
const buildDocumentContext = (doc: {
  tags?: Record<string, string>;
}): Record<string, string> => {
  return buildResourceTagContext({ resourceType: 'document', tags: doc.tags });
};

/**
 * Build SRN resources array (id and path-based) for permission evaluation
 */
const buildDocumentResources = (
  doc: {
    id: string;
    path?: string;
  } & ProjectOwned,
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
    tags?: Record<string, string>;
  } & ProjectOwned,
  action: string
): Promise<boolean> => {
  const context = buildDocumentContext(doc);
  const resources = buildDocumentResources(doc, doc.project_id!);
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: doc.project_id!,
    action,
    resources,
    context,
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  return allowed;
};

documentsRouter.get('/documents', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;
  const pathPrefix = ctx.query.path_prefix as string | undefined;
  const tags = readTagQuery(ctx.query.tags);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'documents:ListDocuments',
    resourceType: 'document',
  });

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
    ctx.body = await listDocuments({
      projectIds,
      policyWhere,
      pathPrefix,
      tags,
      limit,
      offset,
    });
    return;
  }

  ctx.body = await listDocuments({
    projectIds,
    pathPrefix,
    tags,
    limit,
    offset,
  });
});

documentsRouter.get('/documents/:document_id', async (ctx: Context) => {
  requireAuth(ctx);

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:GetDocument'))) {
    return;
  }

  ctx.body = doc;
});

documentsRouter.post('/documents', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    content: string;
    path?: string;
    filename?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    tags?: unknown;
    chunk_strategy?: 'page' | 'whole' | 'size';
    chunk_size?: number;
    chunk_overlap?: number;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'documents:CreateDocument',
    resourceType: 'document',
  });
  // Asserted here rather than inside `createDocument`: every conversation
  // message is a Document too, and that path must never be refused mid-turn
  // (#1249).
  await assertStorageQuota({
    projectId: Number(targetProjectId),
    addedBytes: contentBytes(body.content),
  });
  const doc = await createDocument({
    projectId: Number(targetProjectId),
    content: body.content,
    path: body.path,
    filename: body.filename,
    title: body.title,
    metadata: body.metadata,
    tags: readTagBag(body.tags),
    chunkStrategy: body.chunk_strategy,
    chunkSize: body.chunk_size,
    chunkOverlap: body.chunk_overlap,
  });
  ctx.status = 201;
  ctx.body = doc;
});

documentsRouter.delete('/documents/:document_id', async (ctx: Context) => {
  requireAuth(ctx);

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:DeleteDocument'))) {
    return;
  }

  const result = await deleteDocument({ id: ctx.params.document_id });
  if (result === null) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  ctx.status = 204;
});

documentsRouter.patch('/documents/:document_id', async (ctx: Context) => {
  requireAuth(ctx);

  const doc = await getDocument({ id: ctx.params.document_id });
  if (!doc) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:UpdateDocument'))) {
    return;
  }

  const body = ctx.request.body as {
    content?: string;
    title?: string;
    path?: string | null;
    metadata?: Record<string, unknown>;
    tags?: unknown;
  };

  const updated = await updateDocument({
    id: ctx.params.document_id,
    content: body.content,
    title: body.title,
    path: body.path,
    metadata: body.metadata,
    tags: readTagBag(body.tags),
  });
  ctx.body = updated;
});

documentsRouter.get('/documents/:document_id/status', async (ctx: Context) => {
  requireAuth(ctx);

  const status = await getDocumentStatus({ id: ctx.params.document_id });
  if (!status) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  if (!(await checkDocumentPermission(ctx, status, 'documents:GetDocument'))) {
    return;
  }

  // Return only the lightweight lifecycle payload — never chunk content.
  ctx.body = {
    id: status.id,
    status: status.status,
    chunk_count: status.chunk_count,
    total_chunks: status.total_chunks,
    total_pages: status.total_pages,
    progress: status.progress,
    error: status.error,
  };
});

const resolveDocument = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  const doc = await getDocument({ id: args.ctx.params.document_id });
  if (!doc) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  await checkDocumentPermission(
    args.ctx,
    doc,
    args.access === 'read'
      ? 'documents:GetDocument'
      : 'documents:UpdateDocument'
  );

  return doc;
};

registerTagRoutes({
  router: documentsRouter,
  path: '/documents/:document_id/tags',
  resolve: resolveDocument,
  readTags: ({ resource }) => {
    return getDocumentTags({ id: resource.id });
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateDocumentTags({ id: resource.id, tags, merge });
  },
});

documentsRouter.post('/documents/ingest', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    file_id: string;
    project_id?: string;
    path_prefix?: string;
    tags?: unknown;
    chunk_strategy?: 'page' | 'whole' | 'size';
    chunk_size?: number;
    chunk_overlap?: number;
  };

  // Background by default; ?wait=true blocks and returns 201.
  const wait = ctx.query['wait'] === 'true';

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'documents:IngestDocument',
    resourceType: 'document',
  });
  const result = await enqueueDocumentIngestion({
    fileId: body.file_id,
    projectId: Number(targetProjectId),
    pathPrefix: body.path_prefix,
    tags: readTagBag(body.tags),
    chunkStrategy: body.chunk_strategy,
    chunkSize: body.chunk_size,
    chunkOverlap: body.chunk_overlap,
    wait,
  });

  ctx.status = wait ? 201 : 202;
  ctx.body = result;
});

documentsRouter.post('/documents/:document_id/ingest', async (ctx: Context) => {
  requireAuth(ctx);

  const doc = await getDocumentStatus({ id: ctx.params.document_id });
  if (!doc) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  if (!(await checkDocumentPermission(ctx, doc, 'documents:IngestDocument'))) {
    return;
  }

  const body = ctx.request.body as {
    chunk_strategy?: 'page' | 'whole' | 'size';
    chunk_size?: number;
    chunk_overlap?: number;
  };

  // Background by default; ?wait=true blocks and returns 201.
  const wait = ctx.query['wait'] === 'true';

  const result = await reingestDocument({
    id: ctx.params.document_id,
    chunkStrategy: body.chunk_strategy,
    chunkSize: body.chunk_size,
    chunkOverlap: body.chunk_overlap,
    wait,
  });

  ctx.status = wait ? 201 : 202;
  ctx.body = result;
});

registerIngestionCallbackRoute({ documentsRouter });

export { documentsRouter };
