import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';

/** The width of every `idempotency_key` column. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** Header carrying the key; Node lower-cases incoming header names. */
const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Body field carrying the key. */
const IDEMPOTENCY_FIELD = 'idempotency_key';

/**
 * Refused rather than coerced: a caller whose key arrived as a number wanted
 * at-most-once and would silently get at-least-once.
 */
const parseKey = (args: { raw: unknown; source: string }) => {
  if (typeof args.raw !== 'string' || args.raw.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.source} must be a non-empty string.`
    );
  }
  if (args.raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.source} must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`
    );
  }
  return args.raw;
};

const headerKey = (ctx: Context): string | undefined => {
  const raw = ctx.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined) return undefined;
  // A repeated header arrives as a list. Two values are two keys.
  if (Array.isArray(raw)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Idempotency-Key was sent more than once. A request has one key.'
    );
  }
  return parseKey({ raw, source: 'Idempotency-Key' });
};

const bodyKey = (ctx: Context): string | undefined => {
  const body: unknown = ctx.request?.body;
  const raw =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[IDEMPOTENCY_FIELD]
      : undefined;
  if (raw === undefined || raw === null) return undefined;
  return parseKey({ raw, source: IDEMPOTENCY_FIELD });
};

/**
 * A request's deduplication key, from the `Idempotency-Key` header or the
 * `idempotency_key` body field. They are one key, so two different values are
 * a contradiction and are refused rather than ranked.
 * `idempotencyKeyContract.test.ts` keeps every idempotent route on this reader.
 */
export const idempotencyKeyOf = (ctx: Context): string | undefined => {
  const fromHeader = headerKey(ctx);
  const fromBody = bodyKey(ctx);
  if (
    fromHeader !== undefined &&
    fromBody !== undefined &&
    fromHeader !== fromBody
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Idempotency-Key and ${IDEMPOTENCY_FIELD} name different keys. A request has one key.`
    );
  }
  return fromHeader ?? fromBody;
};
