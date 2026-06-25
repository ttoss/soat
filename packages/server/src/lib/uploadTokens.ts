import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildPath } from './files';

const log = createDebug('soat:upload-tokens');

/** Default upload-token lifetime: 15 minutes. */
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Creates a short-lived, single-use upload token for a project — the
 * local-storage equivalent of an S3 presigned URL. The returned token value is
 * embedded in the upload URL the client then POSTs the file content to.
 */
export const createUploadToken = async (args: {
  projectId: number;
  prefix?: string;
  filename?: string;
  contentType?: string;
  ttlMs?: number;
}) => {
  log(
    'createUploadToken: projectId=%d prefix=%s filename=%s',
    args.projectId,
    args.prefix,
    args.filename
  );

  const expiresAt = new Date(Date.now() + (args.ttlMs ?? UPLOAD_TOKEN_TTL_MS));

  // Store the pre-built full path (key) so the upload lands at the authorized
  // location regardless of the uploaded file's own name.
  const token = await db.UploadToken.create({
    projectId: args.projectId,
    filename: args.filename,
    contentType: args.contentType,
    path: buildPath({ prefix: args.prefix, filename: args.filename }),
    expiresAt,
  });

  log('createUploadToken: created token=%s', token.publicId);

  return {
    uploadToken: token.publicId,
    uploadUrl: `/api/v1/files/upload/${token.publicId}`,
    expiresAt: token.expiresAt,
  };
};

/**
 * Validates and consumes an upload token. Throws a DomainError when the token
 * is unknown, expired, or already used. On success the token is marked used
 * (single-use) and its metadata is returned for the upload to proceed.
 */
export const consumeUploadToken = async (args: { token: string }) => {
  log('consumeUploadToken: token=%s', args.token);

  const token = await db.UploadToken.findOne({
    where: { publicId: args.token },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!token) {
    throw new DomainError(
      'UPLOAD_TOKEN_NOT_FOUND',
      `Upload token '${args.token}' not found.`
    );
  }

  if (token.usedAt) {
    throw new DomainError(
      'UPLOAD_TOKEN_USED',
      `Upload token '${args.token}' has already been used.`
    );
  }

  if (token.expiresAt.getTime() <= Date.now()) {
    throw new DomainError(
      'UPLOAD_TOKEN_EXPIRED',
      `Upload token '${args.token}' has expired.`
    );
  }

  await token.update({ usedAt: new Date() });

  log('consumeUploadToken: consumed token=%s', token.publicId);

  return {
    projectId: token.projectId,
    projectPublicId: token.project?.publicId,
    filename: token.filename,
    contentType: token.contentType,
    path: token.path ?? undefined,
  };
};
