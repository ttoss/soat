import fs from 'node:fs';
import os from 'node:os';

import type { MulterFile } from '@ttoss/http-server';
import { multer, Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { readFileLifetime } from 'src/lib/fileLifetime';
import { createFile, listFiles, uploadFile } from 'src/lib/files';
import { parseMetadataBag, parseMetadataBagField } from 'src/lib/metadataBag';
import { emptyPage } from 'src/lib/pagination';
import { getUploadMaxBytes } from 'src/lib/requestBounds';
import { bufferBody, fileBody, requestBody } from 'src/lib/storageBody';
import { readTagQuery } from 'src/lib/tags';
import { consumeUploadToken, createPresignedUrl } from 'src/lib/uploadTokens';

import { registerFileAccessRoutes } from './fileAccessRoutes';
import { resolveFileWriteProjectId } from './fileWriteAccess';
import { parsePagination, requireAuth } from './helpers';
import { resolveListScope } from './listScope';
import { compileReadPolicy } from './readPolicy';

type Next = () => Promise<unknown>;

/**
 * Spools the `file` part of a multipart upload to the temp directory, bounded,
 * so memory stays flat whatever the file's size; the spool is removed once the
 * handler is done. Built per request because multer fixes its limits at
 * construction.
 */
const uploadSingleFile = async (ctx: Context, next: Next) => {
  try {
    await multer({
      storage: multer.diskStorage({ destination: os.tmpdir() }),
      limits: { fileSize: getUploadMaxBytes(), files: 1 },
    }).single('file')(ctx, next);
  } finally {
    const spooled = ctx.file as MulterFile | undefined;
    if (spooled?.path) await fs.promises.rm(spooled.path, { force: true });
  }
};

const spooledBody = (file: MulterFile) => {
  return fileBody({ path: file.path, size: file.size });
};

/**
 * Runs ahead of the parser, so an anonymous caller is answered before the body
 * is read into memory rather than after — `requireAuth` inside the handler is
 * too late to keep an unauthenticated request from buffering a whole file.
 */
const requireAuthBeforeUpload = (ctx: Context, next: Next) => {
  requireAuth(ctx);
  return next();
};

const filesRouter = new Router<Context>();

filesRouter.get('/files', async (ctx: Context) => {
  requireAuth(ctx);

  const pathPrefix = (ctx.query as Record<string, string>).path_prefix;
  const tags = readTagQuery(ctx.query.tags);
  const { limit, cursor } = parsePagination(ctx);

  const { projectIds, projectPublicId } = await resolveListScope({
    ctx,
    action: 'files:GetFile',
    resourceType: 'file',
    projectSelector: 'optional',
  });

  const { where: policyWhere, hasAccess } = await compileReadPolicy({
    ctx,
    projectPublicId,
    projectIds,
    action: 'files:GetFile',
    resourceType: 'file',
  });
  if (!hasAccess) {
    ctx.body = emptyPage({ limit, cursor });
    return;
  }

  ctx.body = await listFiles({
    projectIds,
    policyWhere,
    pathPrefix,
    tags,
    limit,
    cursor,
  });
});

/** The lifetime fields every create route reads, as sent. */
type LifetimeFields = {
  expires_in?: unknown;
  expires_at?: unknown;
  delete_after?: unknown;
};

const lifetimeOf = (body: LifetimeFields) => {
  return readFileLifetime({
    expiresIn: body.expires_in,
    expiresAt: body.expires_at,
    deleteAfter: body.delete_after,
  });
};

filesRouter.post('/files', async (ctx: Context) => {
  requireAuth(ctx);
  // POST /files is deliberately lenient — it accepts and ignores client-supplied
  // storage fields — so it is excluded from strict field validation.

  const body = ctx.request.body as LifetimeFields & {
    project_id?: string;
    prefix?: string;
    filename?: string;
    content_type?: string;
    size?: number;
    metadata?: unknown;
  };

  const targetProjectId = await resolveFileWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'files:CreateFile',
    prefix: body.prefix,
    filename: body.filename,
  });
  // The key (`path`) is built from `prefix` (directory, default /) + `filename`.
  // storageType / storagePath are system-managed, so any storage_* / path a
  // caller supplies is intentionally ignored.
  const file = await createFile({
    projectId: Number(targetProjectId),
    prefix: body.prefix,
    filename: body.filename,
    contentType: body.content_type,
    size: body.size,
    metadata: parseMetadataBag(body.metadata),
    lifetime: lifetimeOf(body),
  });
  ctx.status = 201;
  ctx.body = file;
});

filesRouter.post(
  '/files/upload',
  requireAuthBeforeUpload,
  uploadSingleFile,
  async (ctx: Context) => {
    requireAuth(ctx);
    const body = ctx.request.body as LifetimeFields & {
      project_id?: string;
      metadata?: unknown;
      prefix?: string;
      filename?: string;
    };
    const file = ctx.file as MulterFile | undefined;
    // The spec's `project_id` is the only name this route accepts, multipart
    // included — one casing everywhere (`.claude/rules/case-convention.md`).
    const projectId = body.project_id;

    if (!file) {
      throw new DomainError('VALIDATION_FAILED', 'No file provided');
    }

    // The uploaded file's name is the default filename unless overridden.
    const filename = body.filename ?? file.originalname;
    const targetProjectId = await resolveFileWriteProjectId({
      ctx,
      projectPublicId: projectId,
      action: 'files:UploadFile',
      prefix: body.prefix,
      filename,
    });
    const record = await uploadFile({
      projectId: Number(targetProjectId),
      body: spooledBody(file),
      prefix: body.prefix,
      filename,
      contentType: file.mimetype,
      metadata: parseMetadataBagField(body.metadata),
      lifetime: lifetimeOf(body),
    });

    ctx.status = 201;
    ctx.body = record;
  }
);

filesRouter.post('/files/upload/base64', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as LifetimeFields & {
    project_id?: string;
    content: string;
    prefix?: string;
    filename?: string;
    content_type?: string;
    metadata?: unknown;
  };

  const targetProjectId = await resolveFileWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'files:UploadFile',
    prefix: body.prefix,
    filename: body.filename,
  });
  const record = await uploadFile({
    projectId: Number(targetProjectId),
    body: bufferBody({ buffer: Buffer.from(body.content, 'base64') }),
    prefix: body.prefix,
    filename: body.filename,
    contentType: body.content_type,
    metadata: parseMetadataBag(body.metadata),
    lifetime: lifetimeOf(body),
  });

  ctx.status = 201;
  ctx.body = record;
});

filesRouter.post('/files/presigned-url', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as LifetimeFields & {
    project_id?: string;
    prefix?: string;
    filename?: string;
    content_type?: string;
    max_bytes?: number;
  };

  const targetProjectId = await resolveFileWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'files:UploadFile',
    prefix: body.prefix,
    filename: body.filename,
  });

  const token = await createPresignedUrl({
    projectId: Number(targetProjectId),
    prefix: body.prefix,
    filename: body.filename,
    contentType: body.content_type,
    maxBytes: body.max_bytes,
    fileLifetime: {
      expiresIn: body.expires_in,
      expiresAt: body.expires_at,
      deleteAfter: body.delete_after,
    },
  });

  ctx.status = 201;
  ctx.body = token;
});

/** The file a token upload carries: a multipart `file` or base64 `content`. */
const tokenUploadOf = (ctx: Context) => {
  const multipartFile = ctx.file as MulterFile | undefined;
  const body = ctx.request.body as {
    content?: string;
    filename?: string;
    content_type?: string;
    metadata?: unknown;
  };
  if (multipartFile) {
    return {
      body: spooledBody(multipartFile),
      filename: multipartFile.originalname,
      contentType: multipartFile.mimetype,
      metadata: body.metadata,
    };
  }
  if (!body.content) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'No file provided: the request carries neither multipart field "file" nor base64 "content".'
    );
  }
  return {
    body: bufferBody({ buffer: Buffer.from(body.content, 'base64') }),
    filename: body.filename,
    contentType: body.content_type,
    metadata: body.metadata,
  };
};

/**
 * Token-authenticated upload. No bearer credential is required — the single-use
 * token issued by POST /files/presigned-url is the credential. Accepts either
 * multipart/form-data (field `file`) or JSON with a base64 `content` field.
 */
filesRouter.post(
  '/files/upload/:token',
  uploadSingleFile,
  async (ctx: Context) => {
    const upload = tokenUploadOf(ctx);
    const tokenData = await consumeUploadToken({
      token: ctx.params.token,
      size: upload.body.size,
      contentType: upload.contentType,
    });

    const record = await uploadFile({
      projectId: tokenData.projectId,
      projectPublicId: tokenData.projectPublicId,
      body: upload.body,
      // The token fixes the location: its pre-built path wins. The filename
      // falls back to the uploaded file's name only when the token set none.
      path: tokenData.path,
      filename: tokenData.filename ?? upload.filename,
      contentType: tokenData.contentType,
      metadata: parseMetadataBagField(upload.metadata),
      lifetime: tokenData.lifetime,
    });

    ctx.status = 201;
    ctx.body = record;
  }
);

/**
 * Token-authenticated raw-body upload: the request body is the file, streamed
 * to storage, so a browser can PUT a `File` as is. The body parser is off for
 * this route (`rawUploadBodyMiddleware`).
 */
filesRouter.put('/files/upload/:token', async (ctx: Context) => {
  const declared = ctx.get('content-length');
  const size = Number(declared);
  if (!declared || !Number.isSafeInteger(size) || size < 0) {
    throw new DomainError(
      'UPLOAD_LENGTH_REQUIRED',
      'The upload declares no Content-Length.'
    );
  }

  const tokenData = await consumeUploadToken({
    token: ctx.params.token,
    size,
    contentType: ctx.get('content-type') || undefined,
  });

  const record = await uploadFile({
    projectId: tokenData.projectId,
    projectPublicId: tokenData.projectPublicId,
    body: requestBody({ stream: ctx.req, size }),
    path: tokenData.path,
    filename: tokenData.filename,
    contentType: tokenData.contentType,
    lifetime: tokenData.lifetime,
  });

  ctx.status = 201;
  ctx.body = record;
});

registerFileAccessRoutes({ filesRouter });

export { filesRouter };
