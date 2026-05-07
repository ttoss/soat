import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  deleteFile,
  downloadFile,
  getFile,
  getFileTags,
  updateFileMetadata,
  updateFileTags,
} from 'src/lib/files';

import { db } from '../../db';
import { canAccessFile } from './fileAuthorization';

const collectStreamToBuffer = async (args: {
  stream: AsyncIterable<unknown>;
}) => {
  const chunks: Buffer[] = [];
  for await (const chunk of args.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

const ensureAuthenticated = (args: { ctx: Context }): boolean => {
  if (!args.ctx.authUser) {
    args.ctx.status = 401;
    args.ctx.body = { error: 'Unauthorized' };
    return false;
  }

  return true;
};

const ensureFileExists = async (args: { ctx: Context }) => {
  const file = await getFile({ id: args.ctx.params.file_id });
  if (!file) {
    args.ctx.status = 404;
    args.ctx.body = { error: 'File not found' };
    return null;
  }

  return file;
};

const ensureAllowed = async (args: {
  ctx: Context;
  action: 'files:GetFile' | 'files:DownloadFile' | 'files:UpdateFileMetadata';
  file: {
    id: string;
    projectId?: string | null;
    path?: string | null;
    tags?: Record<string, unknown> | null;
  };
}) => {
  const allowed = await canAccessFile({
    authUser: args.ctx.authUser!,
    action: args.action,
    file: {
      id: args.file.id,
      projectId: args.file.projectId!,
      path: args.file.path,
      tags: args.file.tags,
    },
  });

  if (!allowed) {
    args.ctx.status = 403;
    args.ctx.body = { error: 'Forbidden' };
  }

  return allowed;
};

const registerGetFileRoute = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.get('/files/:file_id', async (ctx: Context) => {
    if (!ensureAuthenticated({ ctx })) return;

    const file = await ensureFileExists({ ctx });
    if (!file) return;

    const allowed = await ensureAllowed({ ctx, action: 'files:GetFile', file });
    if (!allowed) return;

    ctx.body = file;
  });
};

const registerDeleteFileRoute = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.delete('/files/:file_id', async (ctx: Context) => {
    if (!ensureAuthenticated({ ctx })) return;

    const file = await db.File.findOne({
      where: { publicId: ctx.params.file_id },
      include: [{ model: db.Project, as: 'project' }],
    });
    if (!file) {
      ctx.status = 404;
      ctx.body = { error: 'File not found' };
      return;
    }

    const allowed = await canAccessFile({
      authUser: ctx.authUser!,
      action: 'files:DeleteFile',
      file: {
        id: file.publicId,
        projectId: file.project!.publicId,
        path: (file as { path?: string | null }).path,
        tags: file.tags as Record<string, unknown> | null,
      },
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const result = await deleteFile({ id: ctx.params.file_id });
    if (result === null) {
      ctx.status = 404;
      ctx.body = { error: 'File not found' };
      return;
    }

    ctx.status = 204;
  });
};

const registerDownloadRoutes = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.get('/files/:file_id/download', async (ctx: Context) => {
    if (!ensureAuthenticated({ ctx })) return;

    const file = await ensureFileExists({ ctx });
    if (!file) return;

    const allowed = await ensureAllowed({
      ctx,
      action: 'files:DownloadFile',
      file,
    });
    if (!allowed) return;

    const result = await downloadFile({ id: ctx.params.file_id });
    if (!result) {
      ctx.status = 404;
      ctx.body = { error: 'File not found on disk' };
      return;
    }

    ctx.set('Content-Type', result.contentType ?? 'application/octet-stream');
    if (result.filename) {
      ctx.set(
        'Content-Disposition',
        `attachment; filename="${result.filename}"`
      );
    }
    if (result.size != null) {
      ctx.set('Content-Length', String(result.size));
    }
    ctx.body = result.stream;
  });

  args.filesRouter.get(
    '/files/:file_id/download/base64',
    async (ctx: Context) => {
      if (!ensureAuthenticated({ ctx })) return;

      const file = await ensureFileExists({ ctx });
      if (!file) return;

      const allowed = await ensureAllowed({
        ctx,
        action: 'files:DownloadFile',
        file,
      });
      if (!allowed) return;

      const result = await downloadFile({ id: ctx.params.file_id });
      if (!result) {
        ctx.status = 404;
        ctx.body = { error: 'File not found on disk' };
        return;
      }

      const buffer = await collectStreamToBuffer({ stream: result.stream });
      ctx.body = {
        content: buffer.toString('base64'),
        filename: result.filename,
        contentType: result.contentType,
        size: result.size,
      };
    }
  );
};

const registerMetadataRoutes = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.patch('/files/:file_id/metadata', async (ctx: Context) => {
    if (!ensureAuthenticated({ ctx })) return;

    const file = await ensureFileExists({ ctx });
    if (!file) return;

    const allowed = await ensureAllowed({
      ctx,
      action: 'files:UpdateFileMetadata',
      file,
    });
    if (!allowed) return;

    const body = ctx.request.body as { metadata?: string; filename?: string };
    ctx.body = await updateFileMetadata({
      id: ctx.params.file_id,
      metadata: body.metadata,
      filename: body.filename,
    });
  });

  args.filesRouter.get('/files/:file_id/tags', async (ctx: Context) => {
    if (!ensureAuthenticated({ ctx })) return;

    const file = await ensureFileExists({ ctx });
    if (!file) return;

    const allowed = await ensureAllowed({ ctx, action: 'files:GetFile', file });
    if (!allowed) return;

    ctx.body = await getFileTags({ id: ctx.params.file_id });
  });

  args.filesRouter.put('/files/:file_id/tags', async (ctx: Context) => {
    if (!ensureAuthenticated({ ctx })) return;

    const file = await ensureFileExists({ ctx });
    if (!file) return;

    const allowed = await ensureAllowed({
      ctx,
      action: 'files:UpdateFileMetadata',
      file,
    });
    if (!allowed) return;

    const tags = ctx.request.body as Record<string, string>;
    ctx.body = await updateFileTags({
      id: ctx.params.file_id,
      tags,
      merge: false,
    });
  });

  args.filesRouter.patch('/files/:file_id/tags', async (ctx: Context) => {
    if (!ensureAuthenticated({ ctx })) return;

    const file = await ensureFileExists({ ctx });
    if (!file) return;

    const allowed = await ensureAllowed({
      ctx,
      action: 'files:UpdateFileMetadata',
      file,
    });
    if (!allowed) return;

    const tags = ctx.request.body as Record<string, string>;
    ctx.body = await updateFileTags({
      id: ctx.params.file_id,
      tags,
      merge: true,
    });
  });
};

export const registerFileAccessRoutes = (args: {
  filesRouter: Router<Context>;
}) => {
  registerGetFileRoute(args);
  registerDeleteFileRoute(args);
  registerDownloadRoutes(args);
  registerMetadataRoutes(args);
};
