import { DomainError } from 'src/errors';

/** The width of every `idempotency_key` column. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * A request's deduplication key. Refused rather than coerced: a caller whose key
 * arrived as a number wanted at-most-once and would silently get at-least-once.
 */
export const parseIdempotencyKey = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'idempotency_key must be a non-empty string.'
    );
  }
  if (raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `idempotency_key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`
    );
  }
  return raw;
};
