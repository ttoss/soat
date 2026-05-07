import type { MulterFile } from '@ttoss/http-server';
import { multer, Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { createFile, listFiles, uploadFile } from 'src/lib/files';
import { compilePolicy } from 'src/lib/policyCompiler';

import { registerFileAccessRoutes } from './fileAccessRoutes';

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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId: string;
    path?: string;
    filename?: string;
    contentType?: string;
    size?: number;
    storageType: 'local' | 's3' | 'gcs';
    storagePath: string;
    metadata?: string;
  };

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: body.projectId,
    action: 'files:CreateFile',
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

  const file = await createFile({
    ...body,
    projectId: project.id,
  });
  ctx.status = 201;
  ctx.body = file;
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

    if (!projectId) {
      ctx.status = 400;
      ctx.body = { error: 'projectId is required' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: projectId,
      action: 'files:UploadFile',
      resource: `soat:${projectId}:*:*`,
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const project = await db.Project.findOne({
      where: { publicId: projectId },
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
      path: body.path,
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

  const fileBuffer = Buffer.from(body.content, 'base64');

  const record = await uploadFile({
    projectId: project.id,
    fileBuffer,
    path: body.path,
    filename: body.filename,
    contentType: body.contentType,
    metadata: body.metadata,
  });

  ctx.status = 201;
  ctx.body = record;
});

registerFileAccessRoutes({ filesRouter });

export { filesRouter };
