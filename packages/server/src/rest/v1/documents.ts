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

  if (!(await checkDocumentPermission(ctx, doc, 'documents:GetDocument'))) {
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
    if (ctx.authUser.apiKeyProjectId) {
      resolvedProjectPublicId = ctx.authUser.apiKeyProjectId;
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

  if (!(await checkDocumentPermission(ctx, doc, 'documents:DeleteDocument'))) {
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

  if (!(await checkDocumentPermission(ctx, doc, 'documents:UpdateDocument'))) {
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

  if (!(await checkDocumentPermission(ctx, doc, 'documents:GetDocument'))) {
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

  if (!(await checkDocumentPermission(ctx, doc, 'documents:UpdateDocument'))) {
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

  if (!(await checkDocumentPermission(ctx, doc, 'documents:UpdateDocument'))) {
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateDocumentTags({ id: ctx.params.id, tags, merge: true });
});

export { documentsRouter };
