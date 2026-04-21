import type { MulterFile } from '@ttoss/http-server';
import { multer, Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createFile,
  deleteFile,
  downloadFile,
  getFile,
  getFileTags,
  listFiles,
  updateFileMetadata,
  updateFileTags,
  uploadFile,
} from 'src/lib/files';
import { buildSrn } from 'src/lib/iam';

const upload = multer({ storage: multer.memoryStorage() });

const filesRouter = new Router<Context>();

filesRouter.get('/files', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = (ctx.query as Record<string, string>).projectId;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'files:GetFile',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listFiles({
    projectIds: projectIds ?? undefined,
    limit,
    offset,
  });
});

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
  const srn = buildSrn({
    projectPublicId: file.projectId!,
    resourceType: 'file',
    resourceId: file.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (file.tags) {
    for (const [k, v] of Object.entries(file.tags)) {
      context[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: file.projectId!,
    action: 'files:GetFile',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = file;
});

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
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: body.projectId,
    action: 'files:CreateFile',
  });
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
  const srnDel = buildSrn({
    projectPublicId: file.project!.publicId,
    resourceType: 'file',
    resourceId: file.publicId,
  });
  const contextDel: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (file.tags) {
    for (const [k, v] of Object.entries(file.tags as Record<string, string>)) {
      contextDel[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: file.project!.publicId,
    action: 'files:DeleteFile',
    resource: srnDel,
    context: contextDel,
  });
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

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: body.projectId,
      action: 'files:UploadFile',
    });
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

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: body.projectId,
    action: 'files:UploadFile',
  });
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

  const srnDl = buildSrn({
    projectPublicId: fileRecord.projectId!,
    resourceType: 'file',
    resourceId: fileRecord.id,
  });
  const contextDl: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (fileRecord.tags) {
    for (const [k, v] of Object.entries(fileRecord.tags)) {
      contextDl[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: fileRecord.projectId!,
    action: 'files:DownloadFile',
    resource: srnDl,
    context: contextDl,
  });
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

  const srnDlB64 = buildSrn({
    projectPublicId: fileRecord.projectId!,
    resourceType: 'file',
    resourceId: fileRecord.id,
  });
  const contextDlB64: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (fileRecord.tags) {
    for (const [k, v] of Object.entries(fileRecord.tags)) {
      contextDlB64[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: fileRecord.projectId!,
    action: 'files:DownloadFile',
    resource: srnDlB64,
    context: contextDlB64,
  });
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

  const srnMeta = buildSrn({
    projectPublicId: fileRecord.projectId!,
    resourceType: 'file',
    resourceId: fileRecord.id,
  });
  const contextMeta: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (fileRecord.tags) {
    for (const [k, v] of Object.entries(fileRecord.tags)) {
      contextMeta[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: fileRecord.projectId!,
    action: 'files:UpdateFileMetadata',
    resource: srnMeta,
    context: contextMeta,
  });
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

filesRouter.get('/files/:id/tags', async (ctx: Context) => {
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

  const srn = buildSrn({
    projectPublicId: file.projectId!,
    resourceType: 'file',
    resourceId: file.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (file.tags) {
    for (const [k, v] of Object.entries(file.tags)) {
      context[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: file.projectId!,
    action: 'files:GetFile',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getFileTags({ id: ctx.params.id });
});

filesRouter.put('/files/:id/tags', async (ctx: Context) => {
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

  const srn = buildSrn({
    projectPublicId: file.projectId!,
    resourceType: 'file',
    resourceId: file.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (file.tags) {
    for (const [k, v] of Object.entries(file.tags)) {
      context[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: file.projectId!,
    action: 'files:UpdateFileMetadata',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateFileTags({ id: ctx.params.id, tags, merge: false });
});

filesRouter.patch('/files/:id/tags', async (ctx: Context) => {
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

  const srn = buildSrn({
    projectPublicId: file.projectId!,
    resourceType: 'file',
    resourceId: file.id,
  });
  const context: Record<string, string> = { 'soat:ResourceType': 'file' };
  if (file.tags) {
    for (const [k, v] of Object.entries(file.tags)) {
      context[`soat:ResourceTag/${k}`] = v;
    }
  }
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: file.projectId!,
    action: 'files:UpdateFileMetadata',
    resource: srn,
    context,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const tags = ctx.request.body as Record<string, string>;
  ctx.body = await updateFileTags({ id: ctx.params.id, tags, merge: true });
});

export { filesRouter };
