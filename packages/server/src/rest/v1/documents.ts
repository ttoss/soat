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
import { compilePolicy } from 'src/lib/policyCompiler';

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
  const srnGetResources: string[] = [srn];
  if (doc.path) {
    srnGetResources.push(
      buildSrn({
        projectPublicId: doc.projectId!,
        resourceType: 'document',
        resourceId: doc.path,
      })
    );
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:GetDocument',
    resources: srnGetResources,
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
    path?: string;
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
    path: body.path,
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
  const resourcesDel: string[] = [srnDel];
  if (doc.path) {
    resourcesDel.push(
      buildSrn({
        projectPublicId: doc.projectId!,
        resourceType: 'document',
        resourceId: doc.path,
      })
    );
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:DeleteDocument',
    resources: resourcesDel,
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
  const resourcesUpd: string[] = [srnUpd];
  if (doc.path) {
    resourcesUpd.push(
      buildSrn({
        projectPublicId: doc.projectId!,
        resourceType: 'document',
        resourceId: doc.path,
      })
    );
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:UpdateDocument',
    resources: resourcesUpd,
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
    path?: string | null;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  };

  const updated = await updateDocument({
    id: ctx.params.id,
    content: body.content,
    title: body.title,
    path: body.path,
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

  // Compile SQL-level policy filter when a specific project is requested
  let policyWhere: Record<string, unknown> | undefined;
  if (body.projectId) {
    const policies = await ctx.authUser!.getPolicies(body.projectId);
    const compiled = compilePolicy({
      policies,
      action: 'documents:SearchDocuments',
      resourceType: 'document',
      projectPublicId: body.projectId,
    });
    if (!compiled.hasAccess) {
      ctx.body = { documents: [] };
      return;
    }
    policyWhere = compiled.where;
  }

  const results = await resolveDocumentQuery({
    projectIds,
    policyWhere,
    config: {
      search: body.search,
      minScore: body.minScore,
      limit: body.limit,
      paths: body.paths,
      documentIds: body.documentIds,
    },
  });

  ctx.body = { documents: results };
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
  const srnTagsGetResources: string[] = [srn];
  if (doc.path) {
    srnTagsGetResources.push(
      buildSrn({
        projectPublicId: doc.projectId!,
        resourceType: 'document',
        resourceId: doc.path,
      })
    );
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:GetDocument',
    resources: srnTagsGetResources,
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
  const srnTagsPutResources: string[] = [srn];
  if (doc.path) {
    srnTagsPutResources.push(
      buildSrn({
        projectPublicId: doc.projectId!,
        resourceType: 'document',
        resourceId: doc.path,
      })
    );
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:UpdateDocument',
    resources: srnTagsPutResources,
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
  const srnTagsPatchResources: string[] = [srn];
  if (doc.path) {
    srnTagsPatchResources.push(
      buildSrn({
        projectPublicId: doc.projectId!,
        resourceType: 'document',
        resourceId: doc.path,
      })
    );
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: doc.projectId!,
    action: 'documents:UpdateDocument',
    resources: srnTagsPatchResources,
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
