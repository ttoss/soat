import { createHash } from 'node:crypto';

import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildPath } from './files';

const log = createDebug('soat:upload-tokens');

/**
 * A token is the credential this route authenticates with, so the log carries a
 * short hash of it instead: enough to follow one token through a log, never
 * enough to replay it. Debug logs are enabled per namespace by an operator and
 * land wherever the process's stderr goes, which is not a place a live
 * credential belongs.
 */
const fingerprintToken = (token: string): string => {
  return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
};

/** Default upload-token lifetime: 15 minutes. */
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Creates a short-lived, single-use presigned upload URL for a project — the
 * local-storage equivalent of an S3 presigned URL. The returned token value is
 * embedded in the upload URL the client then POSTs the file content to.
 */
export const createPresignedUrl = async (args: {
  projectId: number;
  prefix?: string;
  filename?: string;
  contentType?: string;
  ttlMs?: number;
}) => {
  log(
    'createPresignedUrl: projectId=%d prefix=%s filename=%s',
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

  log('createPresignedUrl: created token=%s', fingerprintToken(token.publicId));

  const baseUrl = process.env.SOAT_BASE_URL?.replace(/\/$/, '') ?? '';
  return {
    upload_token: token.publicId,
    upload_url: `${baseUrl}/api/v1/files/upload/${token.publicId}`,
    expires_at: token.expiresAt,
  };
};

/**
 * Validates and consumes an upload token. Throws a DomainError when the token
 * is unknown, expired, or already used. On success the token is marked used
 * (single-use) and its metadata is returned for the upload to proceed.
 */
export const consumeUploadToken = async (args: { token: string }) => {
  log('consumeUploadToken: token=%s', fingerprintToken(args.token));

  const token = await db.UploadToken.findOne({
    where: { publicId: args.token },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!token) {
    throw new DomainError(
      'UPLOAD_TOKEN_NOT_FOUND',
      'The upload token was not found.'
    );
  }

  if (token.usedAt) {
    throw new DomainError(
      'UPLOAD_TOKEN_USED',
      'The upload token has already been used.'
    );
  }

  if (token.expiresAt.getTime() <= Date.now()) {
    throw new DomainError(
      'UPLOAD_TOKEN_EXPIRED',
      'The upload token has expired.'
    );
  }

  await token.update({ usedAt: new Date() });

  log(
    'consumeUploadToken: consumed token=%s',
    fingerprintToken(token.publicId)
  );

  return {
    projectId: token.projectId,
    projectPublicId: token.project?.publicId,
    filename: token.filename,
    contentType: token.contentType,
    path: token.path ?? undefined,
  };
};
