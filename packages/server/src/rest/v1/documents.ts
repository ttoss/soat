import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentTags,
  listDocuments,
  searchDocuments,
  updateDocument,
  updateDocumentTags,
} from 'src/lib/documents';
import { buildSrn } from 'src/lib/iam';

const documentsRouter = new Router<Context>();

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

  ctx.body = await listDocuments({ projectIds, limit, offset });
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

  const srnDel = buildSrn({
    projectPublicId: doc.projectId!,
    resourceType: 'document',
    resourceId: doc.id,
  });
  const contextDel: Record<string, string> = {
    'soat:ResourceType': 'document',
  };
  if (doc.tags) {
    for (const [k, v] of Object.entries(doc.tags)) {
      contextDel[`soat:ResourceTag/${k}`] = v;
    }
  }
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

  const srnUpd = buildSrn({
    projectPublicId: doc.projectId!,
    resourceType: 'document',
    resourceId: doc.id,
  });
  const contextUpd: Record<string, string> = {
    'soat:ResourceType': 'document',
  };
  if (doc.tags) {
    for (const [k, v] of Object.entries(doc.tags)) {
      contextUpd[`soat:ResourceTag/${k}`] = v;
    }
  }
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
    query: string;
    limit?: number;
    threshold?: number;
    tags?: Record<string, string>;
  };

  if (!body.query) {
    ctx.status = 400;
    ctx.body = { error: 'query is required' };
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

  const results = await searchDocuments({
    projectIds,
    query: body.query,
    limit: body.limit,
    threshold: body.threshold,
    tags: body.tags,
  });

  ctx.body = results;
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
