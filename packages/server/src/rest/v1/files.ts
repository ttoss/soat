import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { createFile, deleteFile, getFile, listFiles } from 'src/lib/files';

const filesRouter = new Router<Context>();

/**
 * @openapi
 * /files:
 *   get:
 *     tags:
 *       - Files
 *     summary: List all files
 *     description: Returns a list of all stored files
 *     operationId: listFiles
 *     responses:
 *       '200':
 *         description: List of files returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FileRecord'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
filesRouter.get('/files', async (ctx: Context) => {
  ctx.body = await listFiles();
});

/**
 * @openapi
 * /files/{id}:
 *   get:
 *     tags:
 *       - Files
 *     summary: Get a file by ID
 *     description: Returns the data and metadata of a specific file
 *     operationId: getFile
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: File ID
 *         schema:
 *           type: string
 *           example: 'abc123'
 *     responses:
 *       '200':
 *         description: File found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileRecord'
 *       '404':
 *         description: File not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
filesRouter.get('/files/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const file = await getFile({ id: ctx.params.id });

  if (!file) {
    ctx.status = 404;
    ctx.body = { error: 'File not found' };
    return;
  }

  // Check if user is allowed to read files in this project
  const allowed = await ctx.authUser.isAllowed(
    file.projectId!,
    'files:GetFile'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = file;
});

/**
 * @openapi
 * /files:
 *   post:
 *     tags:
 *       - Files
 *     summary: Create a file
 *     description: Creates a new file record in the system
 *     operationId: createFile
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - storageType
 *               - storagePath
 *             properties:
 *               projectId:
 *                 type: string
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               filename:
 *                 type: string
 *                 example: 'document.pdf'
 *               contentType:
 *                 type: string
 *                 example: 'application/pdf'
 *               size:
 *                 type: integer
 *                 example: 1024
 *               storageType:
 *                 type: string
 *                 enum: [local, s3, gcs]
 *                 example: 'local'
 *               storagePath:
 *                 type: string
 *                 example: '/uploads/document.pdf'
 *               metadata:
 *                 type: string
 *                 example: '{"author":"John"}'
 *     responses:
 *       '201':
 *         description: File created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileRecord'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
filesRouter.post('/files', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId: string;
    filename?: string;
    contentType?: string;
    size?: number;
    storageType: 'local' | 's3' | 'gcs';
    storagePath: string;
    metadata?: string;
  };

  // Check if user is allowed to create files in this project
  const allowed = await ctx.authUser.isAllowed(
    body.projectId,
    'files:CreateFile'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  // Convert projectId to internal ID
  const project = await db.Project.findOne({
    where: { publicId: body.projectId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  const file = await createFile({
    ...body,
    projectId: project.id,
  });
  ctx.status = 201;
  ctx.body = file;
});

/**
 * @openapi
 * /files/{id}:
 *   delete:
 *     tags:
 *       - Files
 *     summary: Delete a file
 *     description: Removes a file from the system by ID
 *     operationId: deleteFile
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: ID of the file to delete
 *         schema:
 *           type: string
 *           example: 'abc123'
 *     responses:
 *       '204':
 *         description: File deleted successfully
 *       '404':
 *         description: File not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
filesRouter.delete('/files/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  // Get file to check project permission
  const file = await db.File.findOne({
    where: { publicId: ctx.params.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!file) {
    ctx.status = 404;
    ctx.body = { error: 'File not found' };
    return;
  }

  // Check if user is allowed to delete files in this project
  const allowed = await ctx.authUser.isAllowed(
    file.project!.publicId,
    'files:DeleteFile'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await deleteFile({ id: ctx.params.id });

  if (result === null) {
    ctx.status = 404;
    ctx.body = { error: 'File not found' };
    return;
  }

  ctx.status = 204;
});

export { filesRouter };
