import type { MulterFile } from '@ttoss/http-server';
import { multer, Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { createFile, listFiles, uploadFile } from 'src/lib/files';
import { compilePolicy } from 'src/lib/policyCompiler';
import { consumeUploadToken, createUploadToken } from 'src/lib/uploadTokens';

import { registerFileAccessRoutes } from './fileAccessRoutes';
import { checkAuth, resolveWriteProjectId } from './helpers';

const upload = multer({ storage: multer.memoryStorage() });
const filesRouter = new Router<Context>();

const listFilesWithPolicy = async (args: {
  authUser: NonNullable<Context['authUser']>;
  projectPublicId: string;
  projectIds: number[];
  limit?: number;
  offset?: number;
}) => {
  const { authUser, projectPublicId, projectIds, limit, offset } = args;
  const policies = await authUser.getPolicies(projectPublicId);
  const { where: policyWhere, hasAccess } = compilePolicy({
    policies,
    action: 'files:GetFile',
    resourceType: 'file',
    projectPublicId,
  });

  if (!hasAccess) {
    return { data: [], total: 0, limit: limit ?? 50, offset: offset ?? 0 };
  }

  return listFiles({ projectIds, policyWhere, limit, offset });
};

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

  if (projectPublicId) {
    ctx.body = await listFilesWithPolicy({
      authUser: ctx.authUser,
      projectPublicId,
      projectIds: projectIds ?? [],
      limit,
      offset,
    });
    return;
  }

  ctx.body = await listFiles({
    projectIds: projectIds ?? undefined,
    limit,
    offset,
  });
});

filesRouter.post('/files', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    path?: string;
    filename?: string;
    contentType?: string;
    size?: number;
    metadata?: string;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'files:CreateFile',
  });
  if (targetProjectId === null) return;

  // storageType / storagePath are system-managed; any value supplied by the
  // caller is intentionally ignored by passing only the allowed fields.
  const file = await createFile({
    projectId: Number(targetProjectId),
    path: body.path,
    filename: body.filename,
    contentType: body.contentType,
    size: body.size,
    metadata: body.metadata,
  });
  ctx.status = 201;
  ctx.body = file;
});

filesRouter.post(
  '/files/upload',
  upload.single('file'),
  async (ctx: Context) => {
    if (!checkAuth(ctx)) return;

    const body = ctx.request.body as {
      projectId?: string;
      project_id?: string;
      metadata?: string;
      path?: string;
    };
    const file = ctx.file as MulterFile | undefined;
    const projectId = body.projectId ?? body.project_id;

    if (!file) {
      ctx.status = 400;
      ctx.body = { error: 'No file provided' };
      return;
    }

    const targetProjectId = await resolveWriteProjectId({
      ctx,
      projectPublicId: projectId,
      action: 'files:UploadFile',
    });
    if (targetProjectId === null) return;

    const record = await uploadFile({
      projectId: Number(targetProjectId),
      fileBuffer: file.buffer,
      filename: file.originalname,
      contentType: file.mimetype,
      metadata: body.metadata,
      path: body.path,
    });

    ctx.status = 201;
    ctx.body = record;
  }
);

filesRouter.post('/files/upload/base64', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    content: string;
    path?: string;
    filename?: string;
    contentType?: string;
    metadata?: string;
  };

  if (!body.content) {
    ctx.status = 400;
    ctx.body = { error: 'content is required (base64-encoded)' };
    return;
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'files:UploadFile',
  });
  if (targetProjectId === null) return;

  const fileBuffer = Buffer.from(body.content, 'base64');

  const record = await uploadFile({
    projectId: Number(targetProjectId),
    fileBuffer,
    path: body.path,
    filename: body.filename,
    contentType: body.contentType,
    metadata: body.metadata,
  });

  ctx.status = 201;
  ctx.body = record;
});

filesRouter.post('/files/upload-token', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId: string;
    filename?: string;
    contentType?: string;
    path?: string;
  };

  if (!body.projectId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: body.projectId,
    action: 'files:UploadFile',
    resource: `soat:${body.projectId}:*:*`,
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

  const token = await createUploadToken({
    projectId: project.id,
    filename: body.filename,
    contentType: body.contentType,
    path: body.path,
  });

  ctx.status = 201;
  ctx.body = token;
});

/**
 * Token-authenticated upload. No bearer credential is required — the single-use
 * token issued by POST /files/upload-token is the credential. Accepts either
 * multipart/form-data (field `file`) or JSON with a base64 `content` field.
 */
filesRouter.post(
  '/files/upload/:token',
  upload.single('file'),
  async (ctx: Context) => {
    const tokenValue = ctx.params.token;

    const multipartFile = ctx.file as MulterFile | undefined;
    const body = ctx.request.body as {
      content?: string;
      filename?: string;
      contentType?: string;
      metadata?: string;
    };

    if (!multipartFile && !body.content) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'No file provided. Send multipart field "file" or base64 "content".'
      );
    }

    const tokenData = await consumeUploadToken({ token: tokenValue });

    const fileBuffer = multipartFile
      ? multipartFile.buffer
      : Buffer.from(body.content as string, 'base64');

    const record = await uploadFile({
      projectId: tokenData.projectId,
      projectPublicId: tokenData.projectPublicId,
      fileBuffer,
      path: tokenData.path,
      filename:
        multipartFile?.originalname ?? body.filename ?? tokenData.filename,
      contentType:
        multipartFile?.mimetype ?? body.contentType ?? tokenData.contentType,
      metadata: body.metadata,
    });

    ctx.status = 201;
    ctx.body = record;
  }
);

registerFileAccessRoutes({ filesRouter });

export { filesRouter };
