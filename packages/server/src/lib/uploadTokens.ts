import { createHash } from 'node:crypto';

import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { resolveProjectPublicId } from './eventBus';
import { assertCallerPath } from './filePaths';
import { buildPath } from './files';
import { getUploadMaxBytes } from './requestBounds';
import { buildUploadUrl } from './uploadUrlTemplate';

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

/** `application/pdf; charset=binary` and `Application/PDF` are one type. */
const mediaType = (contentType: string): string => {
  return contentType.split(';')[0].trim().toLowerCase();
};

const assertMaxBytes = (args: { maxBytes: number; ceiling: number }) => {
  if (
    !Number.isInteger(args.maxBytes) ||
    args.maxBytes < 1 ||
    args.maxBytes > args.ceiling
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `max_bytes must be an integer from 1 to ${args.ceiling}, this deployment's upload ceiling.`,
      { limit: args.ceiling }
    );
  }
};

/**
 * Creates a short-lived, single-use presigned upload URL for a project — the
 * local-storage equivalent of an S3 presigned URL. The token fixes where the
 * upload lands, its byte ceiling and, when given, its content type.
 */
export const createPresignedUrl = async (args: {
  projectId: number;
  prefix?: string;
  filename?: string;
  contentType?: string;
  maxBytes?: number;
  ttlMs?: number;
}) => {
  log(
    'createPresignedUrl: projectId=%d prefix=%s filename=%s maxBytes=%s',
    args.projectId,
    args.prefix,
    args.filename,
    args.maxBytes
  );

  const ceiling = getUploadMaxBytes();
  const maxBytes = args.maxBytes ?? ceiling;
  assertMaxBytes({ maxBytes, ceiling });

  const expiresAt = new Date(Date.now() + (args.ttlMs ?? UPLOAD_TOKEN_TTL_MS));

  // Store the pre-built full path (key) so the upload lands at the authorized
  // location regardless of the uploaded file's own name.
  const token = await db.UploadToken.create({
    projectId: args.projectId,
    filename: args.filename,
    contentType: args.contentType,
    maxBytes: String(maxBytes),
    path: assertCallerPath(
      buildPath({ prefix: args.prefix, filename: args.filename })
    ),
    expiresAt,
  });

  log('createPresignedUrl: created token=%s', fingerprintToken(token.publicId));

  return {
    upload_token: token.publicId,
    upload_url: buildUploadUrl({
      projectPublicId: await resolveProjectPublicId({
        projectId: args.projectId,
      }),
      token: token.publicId,
    }),
    max_bytes: maxBytes,
    content_type: token.contentType ?? undefined,
    expires_at: token.expiresAt,
  };
};

type UploadTokenRow = InstanceType<(typeof db)['UploadToken']>;

const assertTokenOpen = (token: UploadTokenRow | null): UploadTokenRow => {
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
  return token;
};

const assertUploadFits = (args: {
  token: UploadTokenRow;
  size: number;
  contentType?: string;
}) => {
  const ceiling = getUploadMaxBytes();
  const fixed = args.token.maxBytes;
  const limit = Math.min(fixed === null ? ceiling : Number(fixed), ceiling);
  if (args.size > limit) {
    throw new DomainError(
      'UPLOAD_TOO_LARGE',
      `The upload is ${args.size} bytes; this token accepts at most ${limit}.`,
      { limit }
    );
  }

  const expected = args.token.contentType;
  if (
    expected &&
    args.contentType &&
    mediaType(expected) !== mediaType(args.contentType)
  ) {
    throw new DomainError(
      'UPLOAD_CONTENT_TYPE_MISMATCH',
      `The upload is ${mediaType(args.contentType)}; this token accepts ${mediaType(expected)}.`,
      { expected }
    );
  }
};

/**
 * Checks an upload against its token and consumes the token. Everything that
 * can refuse the upload is checked before the token is marked used, so a
 * refused upload leaves the token usable; the mark itself is conditional, so
 * two uploads racing on one token cannot both pass.
 */
export const consumeUploadToken = async (args: {
  token: string;
  /** The upload's exact size in bytes. */
  size: number;
  /** The content type the upload declares, if any. */
  contentType?: string;
}) => {
  log(
    'consumeUploadToken: token=%s size=%d',
    fingerprintToken(args.token),
    args.size
  );

  const token = assertTokenOpen(
    await db.UploadToken.findOne({
      where: { publicId: args.token },
      include: [{ model: db.Project, as: 'project' }],
    })
  );
  assertUploadFits({ token, size: args.size, contentType: args.contentType });

  const [marked] = await db.UploadToken.update(
    { usedAt: new Date() },
    { where: { id: token.id, usedAt: null } }
  );
  if (marked === 0) {
    throw new DomainError(
      'UPLOAD_TOKEN_USED',
      'The upload token has already been used.'
    );
  }

  log(
    'consumeUploadToken: consumed token=%s',
    fingerprintToken(token.publicId)
  );

  return {
    projectId: token.projectId,
    projectPublicId: token.project?.publicId,
    filename: token.filename,
    contentType: token.contentType ?? args.contentType,
    path: token.path ?? undefined,
  };
};
