import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  searchDocuments,
  updateDocument,
} from 'src/lib/documents';

const documentsRouter = new Router<Context>();

/**
 * @openapi
 * /documents:
 *   get:
 *     tags:
 *       - Documents
 *     summary: List documents
 *     description: Returns all documents the caller has access to. If projectId is provided, returns only documents in that project. API keys are scoped to a single project automatically. JWT users without projectId receive documents across all their accessible projects.
 *     operationId: listDocuments
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         description: Project ID (optional)
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *       - name: limit
 *         in: query
 *         required: false
 *         description: Maximum number of results to return (default 50)
 *         schema:
 *           type: integer
 *           example: 50
 *       - name: offset
 *         in: query
 *         required: false
 *         description: Number of results to skip (default 0)
 *         schema:
 *           type: integer
 *           example: 0
 *     responses:
 *       '200':
 *         description: List of documents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/DocumentRecord'
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @openapi
 * /documents/{id}:
 *   get:
 *     tags:
 *       - Documents
 *     summary: Get a document by ID
 *     description: Returns a document with its text content
 *     operationId: getDocument
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Document ID
 *         schema:
 *           type: string
 *           example: 'doc_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: Document found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DocumentRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

  const allowed = await ctx.authUser.isAllowed(
    doc.projectId!,
    'documents:GetDocument'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = doc;
});

/**
 * @openapi
 * /documents:
 *   post:
 *     tags:
 *       - Documents
 *     summary: Create a document
 *     description: Creates a new text document with an embedding vector. API keys automatically infer the project from the key's scope; JWT callers must supply projectId.
 *     operationId: createDocument
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID. Required for JWT auth; omit when using an API key.
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               content:
 *                 type: string
 *                 example: 'The quick brown fox jumps over the lazy dog.'
 *               filename:
 *                 type: string
 *                 example: 'my-doc.txt'
 *               title:
 *                 type: string
 *                 example: 'My Document'
 *               metadata:
 *                 type: object
 *                 description: Arbitrary key-value metadata
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ['tag1', 'tag2']
 *     responses:
 *       '201':
 *         description: Document created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DocumentRecord'
 *       '400':
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
    tags?: string[];
  };

  if (!body.content) {
    ctx.status = 400;
    ctx.body = { error: 'content is required' };
    return;
  }

  // Resolve projectId: use explicit value, infer from API key, or error for JWT
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

  const allowed = await ctx.authUser.isAllowed(
    resolvedProjectPublicId,
    'documents:CreateDocument'
  );
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

/**
 * @openapi
 * /documents/{id}:
 *   delete:
 *     tags:
 *       - Documents
 *     summary: Delete a document
 *     description: Deletes a document and its underlying file
 *     operationId: deleteDocument
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Document ID
 *         schema:
 *           type: string
 *           example: 'doc_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '204':
 *         description: Document deleted
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

  const allowed = await ctx.authUser.isAllowed(
    doc.projectId!,
    'documents:DeleteDocument'
  );
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

/**
 * @openapi
 * /documents/{id}:
 *   patch:
 *     tags:
 *       - Documents
 *     summary: Update a document
 *     description: Update a document's content, title, metadata, or tags. Updating content re-computes the embedding vector.
 *     operationId: updateDocument
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Document ID
 *         schema:
 *           type: string
 *           example: 'doc_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content:
 *                 type: string
 *                 description: New text content (re-embeds the document)
 *               title:
 *                 type: string
 *               metadata:
 *                 type: object
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       '200':
 *         description: Document updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DocumentRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

  const allowed = await ctx.authUser.isAllowed(
    doc.projectId!,
    'documents:UpdateDocument'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    content?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
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

/**
 * @openapi
 * /documents/search:
 *   post:
 *     tags:
 *       - Documents
 *     summary: Semantic search over documents
 *     description: Embeds the query text and returns the most similar documents using cosine distance. If projectId is omitted, searches across all projects the caller has access to.
 *     operationId: searchDocuments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID (optional). Omit to search across all accessible projects.
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               query:
 *                 type: string
 *                 example: 'What is the capital of France?'
 *               limit:
 *                 type: integer
 *                 example: 5
 *               threshold:
 *                 type: number
 *                 description: Minimum similarity score (0-1). Only results with score >= threshold are returned.
 *                 example: 0.7
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Filter to documents with any of these tags.
 *                 example: ['tag1', 'tag2']
 *     responses:
 *       '200':
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/DocumentRecord'
 *       '400':
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
    tags?: string[];
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

export { documentsRouter };
