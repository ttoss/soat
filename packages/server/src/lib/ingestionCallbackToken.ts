import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../middleware/auth';

// Lets an external converter deliver an async result without being a SOAT user.
// Scoped to one document + attempt, so a superseded attempt or a replay is
// rejected. No `exp`: a conversion's duration is unknown up front, so expiry is
// governed by CONVERSION_STALL_TIMEOUT_MS and the document's state instead.

const INGESTION_CALLBACK_PURPOSE = 'ingestion-callback';

type IngestionCallbackTokenPayload = {
  documentId: string;
  attemptId: string;
  purpose: string;
};

export const signIngestionCallbackToken = (args: {
  documentId: string;
  attemptId: string;
}): string => {
  return jwt.sign(
    {
      documentId: args.documentId,
      attemptId: args.attemptId,
      purpose: INGESTION_CALLBACK_PURPOSE,
    },
    JWT_SECRET
  );
};

export const verifyIngestionCallbackToken = (args: {
  token: string;
  documentId: string;
}): { attemptId: string } | null => {
  let payload: IngestionCallbackTokenPayload;
  try {
    payload = jwt.verify(
      args.token,
      JWT_SECRET
    ) as IngestionCallbackTokenPayload;
  } catch {
    return null;
  }

  if (
    payload.purpose !== INGESTION_CALLBACK_PURPOSE ||
    payload.documentId !== args.documentId
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
