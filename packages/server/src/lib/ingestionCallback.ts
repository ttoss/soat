import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { ChunkStrategy } from './chunking';
import { parseConverterOutput } from './converterInvocation';
import {
  finalizeIngestedPages,
  parseDocMetadata,
} from './documentIngestionCore';
import { verifyIngestionCallbackToken } from './ingestionCallbackToken';

const log = createDebug('soat:documents');

// A document left in `pending`/`processing` with no progress for longer than
// this is considered abandoned (e.g. the process crashed mid-ingestion) and is
// marked `failed` on the next read so callers can recover. Configurable via
// INGESTION_STALL_TIMEOUT_MS.
const INGESTION_STALL_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// A document awaiting an async converter callback (`conversionAttemptId` set)
// uses this longer timeout instead — speech-to-text and similar jobs can run
// well past the plain ingestion stall window. Configurable via
// CONVERSION_STALL_TIMEOUT_MS.
const CONVERSION_STALL_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const getStallTimeoutMs = (): number => {
  const raw = process.env.INGESTION_STALL_TIMEOUT_MS;
  if (!raw) return INGESTION_STALL_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : INGESTION_STALL_DEFAULT_TIMEOUT_MS;
};

const getConversionStallTimeoutMs = (): number => {
  const raw = process.env.CONVERSION_STALL_TIMEOUT_MS;
  if (!raw) return CONVERSION_STALL_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : CONVERSION_STALL_DEFAULT_TIMEOUT_MS;
};

/**
 * True when a document is in a non-terminal ingestion state (`pending` or
 * `processing`) but has not been touched within the stall timeout — i.e. the
 * ingestion was abandoned (issue #4). A document awaiting an async converter
 * callback (`conversionAttemptId` set) uses the longer
 * `CONVERSION_STALL_TIMEOUT_MS` window instead of `INGESTION_STALL_TIMEOUT_MS`.
 */
export const isIngestionStale = (
  doc: InstanceType<(typeof db)['Document']>
): boolean => {
  if (doc.status !== 'pending' && doc.status !== 'processing') return false;
  const timeoutMs = doc.conversionAttemptId
    ? getConversionStallTimeoutMs()
    : getStallTimeoutMs();
  const updatedAt = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
  return Date.now() - updatedAt > timeoutMs;
};

/**
 * Atomically fails a document awaiting an async conversion, but only if it is
 * still `processing` for the exact attempt recorded on `doc` — a racing
 * ingestion-callback that completes first leaves this a no-op (`false`).
 */
const failStaleConversion = async (
  doc: InstanceType<(typeof db)['Document']>,
  meta: Record<string, unknown>
): Promise<boolean> => {
  const attemptId = doc.conversionAttemptId;
  const [affected] = await db.Document.update(
    {
      status: 'failed',
      conversionAttemptId: null,
      metadata: JSON.stringify({
        ...meta,
        failure_reason: 'CONVERSION_TIMEOUT',
      }),
    },
    {
      where: {
        id: doc.id,
        status: 'processing',
        conversionAttemptId: attemptId,
      },
    }
  );
  if (affected === 0) return false; // a callback already won the race
  await doc.reload();
  log(
    'recoverStaleDocument: marked stalled conversion failed id=%s attemptId=%s',
    doc.publicId,
    attemptId
  );
  return true;
};

/**
 * If a document's ingestion has stalled, transition it to `failed` with an
 * `INGESTION_TIMEOUT` (or, while awaiting an async conversion,
 * `CONVERSION_TIMEOUT`) reason so callers get a terminal state to act on
 * instead of polling forever. Mutates `doc` in place and returns whether it
 * recovered.
 *
 * The conversion branch finishes via an atomic compare-and-set — `UPDATE …
 * WHERE status = 'processing' AND conversion_attempt_id = :attemptId` — so it
 * can never clobber a conversion that `completeIngestionCallback` already
 * completed: if the callback wins the race first, this update affects zero
 * rows and is a no-op.
 */
export const recoverStaleDocument = async (
  doc: InstanceType<(typeof db)['Document']>
): Promise<boolean> => {
  if (!isIngestionStale(doc)) return false;

  const meta = parseDocMetadata(doc.metadata);

  if (doc.conversionAttemptId) {
    return failStaleConversion(doc, meta);
  }

  await doc.update({
    status: 'failed',
    metadata: JSON.stringify({ ...meta, failure_reason: 'INGESTION_TIMEOUT' }),
  });
  log(
    'recoverStaleDocument: marked stalled ingestion failed id=%s',
    doc.publicId
  );
  return true;
};

/**
 * Atomically claims a document's in-flight conversion attempt so exactly one
 * caller (this callback, or the stall sweeper) finishes it. Clearing
 * `conversionAttemptId` here is what makes a replay of this same callback (or
 * a late one that lost the race) find no matching row afterwards.
 */
const claimConversionAttempt = async (args: {
  docId: number;
  attemptId: string;
}): Promise<boolean> => {
  const [claimed] = await db.Document.update(
    { conversionAttemptId: null },
    {
      where: {
        id: args.docId,
        status: 'processing',
        conversionAttemptId: args.attemptId,
      },
    }
  );
  return claimed > 0;
};

type ConversionContext = {
  fileId: string;
  docPath: string;
  chunkStrategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
};

/** Reads back the chunk config computed when the conversion was submitted. */
const readConversionContext = (
  doc: InstanceType<(typeof db)['Document']>
): ConversionContext => {
  const meta = parseDocMetadata(doc.metadata);
  const fileId =
    typeof meta.source_file_id === 'string' ? meta.source_file_id : '';
  const conversion =
    meta.conversion && typeof meta.conversion === 'object'
      ? (meta.conversion as Record<string, unknown>)
      : {};

  return {
    fileId,
    docPath: typeof meta.doc_path === 'string' ? meta.doc_path : `/${fileId}`,
    chunkStrategy:
      typeof conversion.chunk_strategy === 'string'
        ? (conversion.chunk_strategy as ChunkStrategy)
        : undefined,
    chunkSize:
      typeof conversion.chunk_size === 'number'
        ? conversion.chunk_size
        : undefined,
    chunkOverlap:
      typeof conversion.chunk_overlap === 'number'
        ? conversion.chunk_overlap
        : undefined,
  };
};

/**
 * Completes an async conversion delivered by an external converter to
 * `POST /documents/:id/ingestion-callback`. Token-authed rather than
 * IAM-gated (the converter is not a SOAT principal — see
 * ingestionCallbackToken.ts). Accepted only while the document is still
 * `processing` for the exact attempt the token was minted for; the atomic
 * compare-and-set claim means a replay, a callback for a superseded attempt
 * (after re-ingest), or a late callback that lost the race to the stall
 * sweeper all fail with `INGESTION_CALLBACK_CONFLICT` rather than silently
 * corrupting a later attempt's state.
 */
export const completeIngestionCallback = async (args: {
  documentId: string;
  token: string;
  output: unknown;
}): Promise<void> => {
  log('completeIngestionCallback: documentId=%s', args.documentId);

  const doc = await db.Document.findOne({
    where: { publicId: args.documentId },
  });
  if (!doc) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Document '${args.documentId}' not found.`
    );
  }

  const verified = verifyIngestionCallbackToken({
    token: args.token,
    documentId: args.documentId,
  });
  if (!verified) {
    throw new DomainError(
      'INGESTION_CALLBACK_INVALID_TOKEN',
      'The ingestion-callback token is invalid or does not match this document.'
    );
  }

  const claimed = await claimConversionAttempt({
    docId: doc.id as number,
    attemptId: verified.attemptId,
  });
  if (!claimed) {
    throw new DomainError(
      'INGESTION_CALLBACK_CONFLICT',
      `Document '${args.documentId}' is no longer awaiting conversion attempt '${verified.attemptId}' (already completed, timed out, or superseded by a re-ingest).`
    );
  }

  await doc.reload();

  const outcome = parseConverterOutput(args.output);
  if (outcome.status === 'pending') {
    throw new DomainError(
      'CONVERTER_OUTPUT_INVALID',
      'A callback cannot itself defer with { status: "pending" }.'
    );
  }

  const context = readConversionContext(doc);
  await finalizeIngestedPages({
    doc,
    docId: doc.id as number,
    fileId: context.fileId,
    docPath: context.docPath,
    pages: outcome.pages,
    rule: null,
    chunkStrategy: context.chunkStrategy,
    chunkSize: context.chunkSize,
    chunkOverlap: context.chunkOverlap,
  });
};
