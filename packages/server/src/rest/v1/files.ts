import type { MulterFile } from '@ttoss/http-server';
import { multer, Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createFile,
  deleteFile,
  downloadFile,
  getFile,
  listFiles,
  updateFileMetadata,
  uploadFile,
} from 'src/lib/files';

const upload = multer({ storage: multer.memoryStorage() });

const filesRouter = new Router<Context>();

/**
 * @openapi
 * /files:
 *   get:
 *     tags:
 *       - Files
 *     summary: List files
 *     description: Returns a list of files. Requires authentication. Optionally filter by projectId.
 *     operationId: listFiles
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         description: Filter files by project ID
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: List of files returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FileRecord'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 */
filesRouter.get('/files', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = (ctx.query as Record<string, string>).projectId;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'files:GetFile',
  });

  ctx.body = await listFiles({ projectIds: projectIds ?? undefined });
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

/**
 * @openapi
 * /files/upload:
 *   post:
 *     tags:
 *       - Files
 *     summary: Upload a file
 *     description: Uploads a file to the server and stores it in the configured storage directory
 *     operationId: uploadFile
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - projectId
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               projectId:
 *                 type: string
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               metadata:
 *                 type: string
 *                 example: '{"author":"John"}'
 *     responses:
 *       '201':
 *         description: File uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileRecord'
 *       '400':
 *         description: Missing file or invalid project
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 */
filesRouter.post(
  '/files/upload',
  upload.single('file'),
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const body = ctx.request.body as { projectId: string; metadata?: string };
    const file = ctx.file as MulterFile | undefined;

    if (!file) {
      ctx.status = 400;
      ctx.body = { error: 'No file provided' };
      return;
    }

    if (!body.projectId) {
      ctx.status = 400;
      ctx.body = { error: 'projectId is required' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed(
      body.projectId,
      'files:UploadFile'
    );
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const project = await db.Project.findOne({
      where: { publicId: body.projectId },
    });
    if (!project) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid project ID' };
      return;
    }

    const record = await uploadFile({
      projectId: project.id,
      fileBuffer: file.buffer,
      filename: file.originalname,
      contentType: file.mimetype,
      metadata: body.metadata,
    });

    ctx.status = 201;
    ctx.body = record;
  }
);

/**
 * @openapi
 * /files/upload/base64:
 *   post:
 *     tags:
 *       - Files
 *     summary: Upload a file via JSON (base64-encoded)
 *     description: Uploads a file using a JSON body with base64-encoded content. Designed for programmatic/MCP usage.
 *     operationId: uploadFileBase64
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - content
 *             properties:
 *               projectId:
 *                 type: string
 *                 example: 'proj_V1StGXR8Z5jdHi6B'
 *               content:
 *                 type: string
 *                 description: Base64-encoded file content
 *               filename:
 *                 type: string
 *                 example: 'document.txt'
 *               contentType:
 *                 type: string
 *                 example: 'text/plain'
 *               metadata:
 *                 type: string
 *                 example: '{"author":"John"}'
 *     responses:
 *       '201':
 *         description: File uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileRecord'
 *       '400':
 *         description: Missing content or invalid project
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 */
filesRouter.post('/files/upload/base64', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId: string;
    content: string;
    filename?: string;
    contentType?: string;
    metadata?: string;
  };

  if (!body.content) {
    ctx.status = 400;
    ctx.body = { error: 'content is required (base64-encoded)' };
    return;
  }

  if (!body.projectId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed(
    body.projectId,
    'files:UploadFile'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: body.projectId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  const fileBuffer = Buffer.from(body.content, 'base64');

  const record = await uploadFile({
    projectId: project.id,
    fileBuffer,
    filename: body.filename,
    contentType: body.contentType,
    metadata: body.metadata,
  });

  ctx.status = 201;
  ctx.body = record;
});

/**
 * @openapi
 * /files/{id}/download:
 *   get:
 *     tags:
 *       - Files
 *     summary: Download a file
 *     description: Streams the file content to the client
 *     operationId: downloadFile
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: File ID
 *         schema:
 *           type: string
 *           example: 'fil_abc123'
 *     responses:
 *       '200':
 *         description: File content
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         description: File not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
filesRouter.get('/files/:id/download', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const fileRecord = await getFile({ id: ctx.params.id });

  if (!fileRecord) {
    ctx.status = 404;
    ctx.body = { error: 'File not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed(
    fileRecord.projectId!,
    'files:DownloadFile'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await downloadFile({ id: ctx.params.id });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'File not found on disk' };
    return;
  }

  ctx.set('Content-Type', result.contentType ?? 'application/octet-stream');
  if (result.filename) {
    ctx.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  }
  if (result.size != null) {
    ctx.set('Content-Length', String(result.size));
  }
  ctx.body = result.stream;
});

/**
 * @openapi
 * /files/{id}/download/base64:
 *   get:
 *     tags:
 *       - Files
 *     summary: Download a file as base64
 *     description: Returns JSON with base64-encoded file content. Designed for programmatic/MCP usage.
 *     operationId: downloadFileBase64
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: File ID
 *         schema:
 *           type: string
 *           example: 'fil_abc123'
 *     responses:
 *       '200':
 *         description: Base64-encoded file content
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                   description: Base64-encoded file content
 *                 filename:
 *                   type: string
 *                 contentType:
 *                   type: string
 *                 size:
 *                   type: number
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         description: File not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
filesRouter.get('/files/:id/download/base64', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const fileRecord = await getFile({ id: ctx.params.id });

  if (!fileRecord) {
    ctx.status = 404;
    ctx.body = { error: 'File not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed(
    fileRecord.projectId!,
    'files:DownloadFile'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await downloadFile({ id: ctx.params.id });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'File not found on disk' };
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  ctx.body = {
    content: buffer.toString('base64'),
    filename: result.filename,
    contentType: result.contentType,
    size: result.size,
  };
});

/**
 * @openapi
 * /files/{id}/metadata:
 *   patch:
 *     tags:
 *       - Files
 *     summary: Update file metadata
 *     description: Updates the metadata and/or filename of a file
 *     operationId: updateFileMetadata
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: File ID
 *         schema:
 *           type: string
 *           example: 'fil_abc123'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               metadata:
 *                 type: string
 *                 example: '{"author":"Jane","tags":["report"]}'
 *               filename:
 *                 type: string
 *                 example: 'renamed-file.txt'
 *     responses:
 *       '200':
 *         description: File updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileRecord'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         description: File not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
filesRouter.patch('/files/:id/metadata', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const fileRecord = await getFile({ id: ctx.params.id });

  if (!fileRecord) {
    ctx.status = 404;
    ctx.body = { error: 'File not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed(
    fileRecord.projectId!,
    'files:UpdateFileMetadata'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as { metadata?: string; filename?: string };
  const updated = await updateFileMetadata({
    id: ctx.params.id,
    metadata: body.metadata,
    filename: body.filename,
  });

  ctx.body = updated;
});

export { filesRouter };
