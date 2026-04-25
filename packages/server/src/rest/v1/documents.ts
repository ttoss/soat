import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { resolveDocumentQuery } from 'src/lib/documentQuery';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentTags,
  listDocuments,
  updateDocument,
  updateDocumentTags,
} from 'src/lib/documents';
import { buildSrn } from 'src/lib/iam';

const documentsRouter = new Router<Context>();

const buildDocumentSrnContext = (doc: {
  id: string;
  projectId?: string;
  tags?: Record<string, string>;
}) => {
  const srn = buildSrn({
    projectPublicId: doc.projectId!,
    resourceType: 'document',
    resourceId: doc.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'document' };
  if (doc.tags) {
    for (const [k, v] of Object.entries(doc.tags)) {
      context[`soat:ResourceTag/${k}`] = v;
    }
  }
  return { srn, context };
};

const filterDocsByPermission = async <
  T extends { id: string; projectId?: string; tags?: Record<string, string> },
>(
  docs: T[],
  action: string,
  authUser: NonNullable<Context['authUser']>
): Promise<T[]> => {
  const results = await Promise.all(
    docs.map(async (doc) => {
      if (!doc.projectId) return null;
      const { srn, context } = buildDocumentSrnContext(doc);
      const allowed = await authUser.isAllowed({
        projectPublicId: doc.projectId,
        action,
        resource: srn,
        context,
      });
      return allowed ? doc : null;
    })
  );
  return results.filter((d): d is T => {
    return d !== null;
  });
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

  const docs = await listDocuments({ projectIds, limit, offset });
  const filteredData = await filterDocsByPermission(
    docs.data,
    'documents:ListDocuments',
    ctx.authUser!
  );

  ctx.body = {
    data: filteredData,
    total: filteredData.length,
    limit: docs.limit,
    offset: docs.offset,
  };
});

documentsRouter.get('/documents/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.id });

  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  const { srn, context } = buildDocumentSrnContext(doc);
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:GetDocument',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = doc;
});

documentsRouter.post('/documents', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    content: string;
    filename?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  };

  if (!body.content) {
    ctx.status = 400;
    ctx.body = { error: 'content is required' };
    return;
  }

  // Resolve projectId: use explicit value, infer from project key, or error for JWT
  let resolvedProjectPublicId = body.projectId;
  if (!resolvedProjectPublicId) {
    if (ctx.authUser.projectKeyProjectId) {
      resolvedProjectPublicId = ctx.authUser.projectKeyProjectId;
    } else {
      ctx.status = 400;
      ctx.body = { error: 'projectId is required' };
      return;
    }
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'documents:CreateDocument',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: resolvedProjectPublicId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  const doc = await createDocument({
    projectId: project.id,
    content: body.content,
    filename: body.filename,
    title: body.title,
    metadata: body.metadata,
    tags: body.tags,
  });

  ctx.status = 201;
  ctx.body = doc;
});

documentsRouter.delete('/documents/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.id });

  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  const { srn: srnDel, context: contextDel } = buildDocumentSrnContext(doc);
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:DeleteDocument',
    resource: srnDel,
    context: contextDel,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await deleteDocument({ id: ctx.params.id });

  if (result === null) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  ctx.status = 204;
});

documentsRouter.patch('/documents/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.id });

  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  const { srn: srnUpd, context: contextUpd } = buildDocumentSrnContext(doc);
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:UpdateDocument',
    resource: srnUpd,
    context: contextUpd,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    content?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  };

  const updated = await updateDocument({
    id: ctx.params.id,
    content: body.content,
    title: body.title,
    metadata: body.metadata,
    tags: body.tags,
  });

  ctx.body = updated;
});

documentsRouter.post('/documents/search', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    search?: string;
    minScore?: number;
    limit?: number;
    paths?: string[];
    documentIds?: string[];
  };

  if (!body.search && !body.paths && !body.documentIds) {
    ctx.status = 400;
    ctx.body = {
      error: 'At least one of search, paths, or documentIds is required',
    };
    return;
  }

  const projectIds = await ctx.authUser!.resolveProjectIds({
    projectPublicId: body.projectId,
    action: 'documents:SearchDocuments',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const results = await resolveDocumentQuery({
    projectIds,
    config: {
      search: body.search,
      minScore: body.minScore,
      limit: body.limit,
      paths: body.paths,
      documentIds: body.documentIds,
    },
  });

  const filteredDocuments = await filterDocsByPermission(
    results,
    'documents:SearchDocuments',
    ctx.authUser!
  );

  ctx.body = { documents: filteredDocuments };
});

documentsRouter.get('/documents/:id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.id });

  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  const { srn, context } = buildDocumentSrnContext(doc);
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:GetDocument',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getDocumentTags({ id: ctx.params.id });
});

documentsRouter.put('/documents/:id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.id });

  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  const { srn: srnPut, context: contextPut } = buildDocumentSrnContext(doc);
  const allowedPut = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:UpdateDocument',
    resource: srnPut,
    context: contextPut,
  });
  if (!allowedPut) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateDocumentTags({
    id: ctx.params.id,
    tags,
    merge: false,
  });
});

documentsRouter.patch('/documents/:id/tags', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const doc = await getDocument({ id: ctx.params.id });

  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'Document not found' };
    return;
  }

  const { srn, context } = buildDocumentSrnContext(doc);
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:UpdateDocument',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateDocumentTags({ id: ctx.params.id, tags, merge: true });
});

export { documentsRouter };
