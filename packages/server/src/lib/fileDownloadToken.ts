import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../middleware/auth';

// Short-lived, single-purpose token that lets an external converter (which is
// not a SOAT user) fetch a file via GET /files/:id/download?token=... . Scoped
// to one file id so it cannot be used to read any other file. Reuses the app's
// JWT secret — no new key material. (PRD Phase 4.)

const DOWNLOAD_TOKEN_PURPOSE = 'file-download';
const DEFAULT_TTL_SECONDS = 10 * 60; // 10 minutes

type DownloadTokenPayload = {
  fileId: string;
  purpose: string;
};

export const signFileDownloadToken = (args: {
  fileId: string;
  ttlSeconds?: number;
}): string => {
  return jwt.sign(
    { fileId: args.fileId, purpose: DOWNLOAD_TOKEN_PURPOSE },
    JWT_SECRET,
    { expiresIn: args.ttlSeconds ?? DEFAULT_TTL_SECONDS }
  );
};

export const verifyFileDownloadToken = (args: {
  token: string;
  fileId: string;
}): boolean => {
  try {
    const payload = jwt.verify(args.token, JWT_SECRET) as DownloadTokenPayload;
    return (
      payload.purpose === DOWNLOAD_TOKEN_PURPOSE &&
      payload.fileId === args.fileId
    );
  } catch {
    return false;
  }
};

/**
 * Absolute, token-authenticated download URL for a file. Uses `SOAT_BASE_URL`
 * when set (so the URL is reachable by an external provider), falling back to
 * the local server address for in-cluster/self calls.
 */
export const buildFileDownloadUrl = (args: { fileId: string }): string => {
  const base =
    process.env.SOAT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 5047}`;
  const token = signFileDownloadToken({ fileId: args.fileId });
  return `${base.replace(/\/$/, '')}/api/v1/files/${args.fileId}/download?token=${token}`;
};
