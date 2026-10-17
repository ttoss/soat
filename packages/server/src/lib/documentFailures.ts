import { type StoredError, toStoredErrorKeepingMessage } from './storedError';

/** The failures a document records on its own, rather than relays. */
export const DOCUMENT_FAILURES = {
  FILE_NOT_FOUND: {
    code: 'FILE_NOT_FOUND',
    message: 'The file to ingest no longer exists.',
  },
  FILE_PARSE_FAILED: {
    code: 'FILE_PARSE_FAILED',
    message: 'The file contains no extractable text.',
  },
  INGESTION_TIMEOUT: {
    code: 'INGESTION_TIMEOUT',
    message: 'The ingestion made no progress within the stall window.',
  },
  CONVERSION_TIMEOUT: {
    code: 'CONVERSION_TIMEOUT',
    message: 'The converter did not call back within the stall window.',
  },
} satisfies Record<string, StoredError>;

/** A thrown value as a failed ingestion records it. */
export const ingestionFailure = (error: unknown): StoredError => {
  return toStoredErrorKeepingMessage({ error, code: 'INGESTION_FAILED' });
};
