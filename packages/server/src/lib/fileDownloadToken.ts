import { DomainError } from '../errors';
import { signToken, verifyToken } from './signedTokens';

// Lets an external converter fetch one file without being a SOAT user. Scoped
// to a single file id, so it cannot read any other.

const DEFAULT_TTL_SECONDS = 10 * 60; // 10 minutes

export const signFileDownloadToken = (args: {
  fileId: string;
  ttlSeconds?: number;
}): string => {
  return signToken({
    typ: 'file-download',
    claims: { fileId: args.fileId },
    expiresIn: args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  });
};

export const verifyFileDownloadToken = (args: {
  token: string;
  fileId: string;
}): boolean => {
  const payload = verifyToken({ token: args.token, accept: ['file-download'] });
  return payload?.fileId === args.fileId;
};

/**
 * Absolute, token-authenticated download URL for a file, fetched by an
 * external converter (`file_delivery: download_url`). Requires `SOAT_BASE_URL`
 * — unlike an in-cluster/self URL, a relative path or `localhost` address is
 * meaningless to a third-party provider, so an unset base URL fails loudly
 * here rather than silently handing the converter an unreachable address.
 */
export const buildFileDownloadUrl = (args: { fileId: string }): string => {
  const base = process.env.SOAT_BASE_URL;
  if (!base) {
    throw new DomainError(
      'FILE_DOWNLOAD_URL_NOT_CONFIGURED',
      'SOAT_BASE_URL must be set to use file_delivery: download_url — the URL is fetched by an external converter.'
    );
  }
  const token = signFileDownloadToken({ fileId: args.fileId });
  return `${base.replace(/\/$/, '')}/api/v1/files/${args.fileId}/download?token=${token}`;
};
