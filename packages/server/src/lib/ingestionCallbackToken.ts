import { signToken, verifyToken } from './signedTokens';

// Lets an external converter deliver an async result without being a SOAT user.
// Scoped to one document + attempt, so a superseded attempt or a replay is
// rejected.

// Longer, for a document awaiting an async converter: speech-to-text and
// similar jobs run well past the plain ingestion stall window.
const CONVERSION_STALL_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export const getConversionStallTimeoutMs = (): number => {
  const raw = process.env.CONVERSION_STALL_TIMEOUT_MS;
  if (!raw) return CONVERSION_STALL_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : CONVERSION_STALL_DEFAULT_TIMEOUT_MS;
};

/**
 * Expires with the conversion stall window: past it the attempt is timed out,
 * and a callback cannot itself defer, so no callback can still land.
 */
export const signIngestionCallbackToken = (args: {
  documentId: string;
  attemptId: string;
}): string => {
  return signToken({
    typ: 'ingestion-callback',
    claims: { documentId: args.documentId, attemptId: args.attemptId },
    expiresIn: Math.ceil(getConversionStallTimeoutMs() / 1000),
  });
};

export const verifyIngestionCallbackToken = (args: {
  token: string;
  documentId: string;
}): { attemptId: string } | null => {
  const payload = verifyToken({
    token: args.token,
    accept: ['ingestion-callback'],
  });
  if (
    payload?.documentId !== args.documentId ||
    typeof payload.attemptId !== 'string'
  ) {
    return null;
  }
  return { attemptId: payload.attemptId };
};

/**
 * The `callback` block injected into a tool converter's input (see
 * converterInvocation.ts). Returns `null` when `SOAT_BASE_URL` is unset —
 * unlike `file_delivery: download_url`, a missing base URL here does not fail
 * the rule; it just means a tool that wants to defer has nowhere to call back
 * and must respond synchronously instead.
 */
export const buildIngestionCallbackBlock = (args: {
  documentId: string;
  attemptId: string;
}): { url: string; token: string } | null => {
  const base = process.env.SOAT_BASE_URL;
  if (!base) return null;

  const token = signIngestionCallbackToken({
    documentId: args.documentId,
    attemptId: args.attemptId,
  });

  return {
    url: `${base.replace(/\/$/, '')}/api/v1/documents/${args.documentId}/ingestion-callback?token=${token}`,
    token,
  };
};
