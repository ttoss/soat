import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  deleteFile,
  downloadFile,
  getFile,
  getFileTags,
  updateFileMetadata,
  updateFileTags,
} from 'src/lib/files';

import { db } from '../../db';
import { canAccessFile } from '../../lib/fileAuthorization';
import { verifyFileDownloadToken } from '../../lib/fileDownloadToken';
import { type AuthenticatedContext, requireAuth } from './helpers';

const collectStreamToBuffer = async (args: {
  stream: AsyncIterable<unknown>;
}) => {
  const chunks: Buffer[] = [];
  for await (const chunk of args.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

const ensureFileExists = async (args: { ctx: Context }) => {
  const file = await getFile({ id: args.ctx.params.file_id });
  if (!file) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'File not found.');
  }

  return file;
};

const ensureAllowed = async (args: {
  // Narrowed: every caller runs `requireAuth` first, and the type says so.
  ctx: AuthenticatedContext;
  action:
    | 'files:GetFile'
    | 'files:DownloadFile'
    | 'files:UpdateFileMetadata'
    | 'files:DeleteFile';
  file: {
    id: string;
    project_id?: string | null;
    path?: string | null;
    tags?: Record<string, unknown> | null;
  };
}): Promise<void> => {
  const allowed = await canAccessFile({
    authUser: args.ctx.authUser,
    action: args.action,
    file: {
      id: args.file.id,
      projectId: args.file.project_id!,
      path: args.file.path,
      tags: args.file.tags,
    },
  });

  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

const registerGetFileRoute = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.get('/files/:file_id', async (ctx: Context) => {
    requireAuth(ctx);

    const file = await ensureFileExists({ ctx });

    await ensureAllowed({ ctx, action: 'files:GetFile', file });
    ctx.body = file;
  });
};

const registerDeleteFileRoute = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.delete('/files/:file_id', async (ctx: Context) => {
    requireAuth(ctx);

    const file = await db.File.findOne({
      where: { publicId: ctx.params.file_id },
      include: [{ model: db.Project, as: 'project' }],
    });
    if (!file) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'File not found');
    }

    await ensureAllowed({
      ctx,
      action: 'files:DeleteFile',
      file: {
        id: file.publicId,
        project_id: file.project!.publicId,
        path: (file as { path?: string | null }).path,
        tags: file.tags as Record<string, unknown> | null,
      },
    });

    const result = await deleteFile({ id: ctx.params.file_id });
    if (result === null) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'File not found');
    }

    ctx.status = 204;
  });
};

const hasValidDownloadToken = (ctx: Context): boolean => {
  const token = ctx.query.token as string | undefined;
  return (
    typeof token === 'string' &&
    verifyFileDownloadToken({ token, fileId: ctx.params.file_id })
  );
};

/**
 * A valid signed download token authorizes this one file without a SOAT
 * session — used by ingestion-rule converters (see fileDownloadToken.ts).
 * Otherwise falls back to the normal authenticated + policy-checked path.
 */
const ensureDownloadAuthorized = async (args: {
  ctx: Context;
  tokenValid: boolean;
}) => {
  if (args.tokenValid) {
    return ensureFileExists({ ctx: args.ctx });
  }

  requireAuth(args.ctx);

  const file = await ensureFileExists({ ctx: args.ctx });

  await ensureAllowed({
    ctx: args.ctx,
    action: 'files:DownloadFile',
    file,
  });
  return file;
};

const registerDownloadRoutes = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.get('/files/:file_id/download', async (ctx: Context) => {
    await ensureDownloadAuthorized({
      ctx,
      tokenValid: hasValidDownloadToken(ctx),
    });

    const result = await downloadFile({ id: ctx.params.file_id });
    if (!result) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'File not found on disk');
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
      requireAuth(ctx);

      const file = await ensureFileExists({ ctx });

      await ensureAllowed({
        ctx,
        action: 'files:DownloadFile',
        file,
      });
      const result = await downloadFile({ id: ctx.params.file_id });
      if (!result) {
        throw new DomainError('RESOURCE_NOT_FOUND', 'File not found on disk');
      }

      const buffer = await collectStreamToBuffer({ stream: result.stream });
      ctx.body = {
        content: buffer.toString('base64'),
        filename: result.filename,
        content_type: result.contentType,
        size: result.size,
      };
    }
  );
};

const registerMetadataRoutes = (args: { filesRouter: Router<Context> }) => {
  args.filesRouter.patch('/files/:file_id/metadata', async (ctx: Context) => {
    requireAuth(ctx);

    const file = await ensureFileExists({ ctx });

    await ensureAllowed({
      ctx,
      action: 'files:UpdateFileMetadata',
      file,
    });
    const body = ctx.request.body as {
      metadata?: string;
      prefix?: string;
      filename?: string;
    };
    ctx.body = await updateFileMetadata({
      id: ctx.params.file_id,
      metadata: body.metadata,
      prefix: body.prefix,
      filename: body.filename,
    });
  });

  args.filesRouter.get('/files/:file_id/tags', async (ctx: Context) => {
    requireAuth(ctx);

    const file = await ensureFileExists({ ctx });

    await ensureAllowed({ ctx, action: 'files:GetFile', file });
    ctx.body = await getFileTags({ id: ctx.params.file_id });
  });

  args.filesRouter.put('/files/:file_id/tags', async (ctx: Context) => {
    requireAuth(ctx);

    const file = await ensureFileExists({ ctx });

    await ensureAllowed({
      ctx,
      action: 'files:UpdateFileMetadata',
      file,
    });
    const tags = ctx.request.body as Record<string, string>;
    ctx.body = await updateFileTags({
      id: ctx.params.file_id,
      tags,
      merge: false,
    });
  });

  args.filesRouter.patch('/files/:file_id/tags', async (ctx: Context) => {
    requireAuth(ctx);

    const file = await ensureFileExists({ ctx });

    await ensureAllowed({
      ctx,
      action: 'files:UpdateFileMetadata',
      file,
    });
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
