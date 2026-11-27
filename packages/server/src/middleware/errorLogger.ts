import { inspect } from 'node:util';

import { DatabaseError } from '@ttoss/postgresdb';

import type { Context } from '../Context';
import { DomainError, domainErrorBody, errorBody } from '../errors';
import { loggableError } from '../lib/loggableError';

type Next = () => Promise<void>;

const isErrorLoggingEnabled = () => {
  const value = process.env.SOAT_ERROR_LOGS_ENABLED;

  if (value === undefined) {
    return true;
  }

  return !['false', '0', 'off', 'no'].includes(value.toLowerCase());
};

const toDatabaseErrorDetails = (
  error: unknown
): Record<string, unknown> | undefined => {
  if (error instanceof DatabaseError) {
    const original = error.original as
      | (Error & {
          detail?: string;
          code?: string;
          constraint?: string;
          table?: string;
        })
      | undefined;
    // `parameters` — the values the statement was bound with — is deliberately
    // not logged: a failed insert binds whatever the request carried, which on
    // these tables is a secret value, a token or a password hash. The statement
    // text names the columns without carrying anyone's data.
    return {
      sql: error.sql,
      dbError: {
        message: original?.message,
        detail: original?.detail,
        code: original?.code,
        constraint: original?.constraint,
        table: original?.table,
      },
    };
  }

  return undefined;
};

type KoaHttpError = Error & {
  status: number;
  expose: boolean;
  headers?: Record<string, string>;
};

const isKoaHttpError = (error: unknown): error is KoaHttpError => {
  if (!(error instanceof Error)) return false;
  const e = error as unknown as Record<string, unknown>;
  return typeof e.status === 'number' && typeof e.expose === 'boolean';
};

/**
 * A body-parse failure from `co-body`: a client sent something that is not
 * parseable as the declared content type. It carries `status = 400` and the
 * payload as `body` but no `expose`, so `isKoaHttpError` does not match it;
 * recognised here, the one place that maps an error to a response.
 */
const isBodyParseError = (
  error: unknown
): error is Error & { status: number; body?: unknown } => {
  if (!(error instanceof Error)) return false;
  const candidate = error as unknown as Record<string, unknown>;
  return (
    candidate.status === 400 &&
    candidate.expose === undefined &&
    'body' in candidate
  );
};

/**
 * Multer aborts a stream that breaks one of its `limits` with an error of its
 * own class, which carries neither `status` nor `expose`. Recognised by shape
 * rather than by importing multer's class, which `@koa/multer` does not
 * re-export.
 */
const isMulterLimitError = (
  error: unknown
): error is Error & { code: string } => {
  if (!(error instanceof Error) || error.name !== 'MulterError') return false;
  const candidate: Record<string, unknown> = { ...error };
  return typeof candidate.code === 'string';
};

/**
 * Maps errors that are really client faults onto the one error contract, so
 * everything below this line handles a single shape.
 */
const normalizeError = (error: unknown): unknown => {
  if (isBodyParseError(error)) {
    return new DomainError(
      'VALIDATION_FAILED',
      `Malformed request body: ${error.message}`
    );
  }

  if (isMulterLimitError(error)) {
    return error.code === 'LIMIT_FILE_SIZE'
      ? new DomainError('UPLOAD_TOO_LARGE', error.message)
      : new DomainError('VALIDATION_FAILED', error.message);
  }

  return error;
};

const getErrorStatus = (args: { error: unknown }) => {
  if (args.error instanceof DomainError) {
    return args.error.httpStatus;
  }

  if (isKoaHttpError(args.error)) {
    return args.error.status;
  }

  return 500;
};

const writeErrorLog = (args: {
  ctx: Context;
  status: number;
  error: unknown;
}) => {
  const payload = {
    method: args.ctx.method,
    path: args.ctx.path,
    status: args.status,
    requestId: args.ctx.state?.requestId,
    userAgent: args.ctx.get('user-agent') || undefined,
    error: loggableError(args.error),
    ...toDatabaseErrorDetails(args.error),
  };

  // eslint-disable-next-line no-console
  console.error(
    'Request failed:',
    inspect(payload, {
      depth: null,
      compact: false,
      breakLength: 120,
      maxArrayLength: 200,
    })
  );
};

// Seconds until a window resets, from the `resets_at` a windowed refusal's
// meta carries. Null when the meta has no usable timestamp.
const resetsAtRetryAfterSeconds = (
  meta: Record<string, unknown> | undefined
): number | null => {
  const resetsAt = meta?.resets_at;
  if (typeof resetsAt !== 'string') return null;
  const ms = new Date(resetsAt).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
};

const RETRY_AFTER_CODES: ReadonlySet<string> = new Set([
  'QUOTA_EXCEEDED',
  'SHARE_CAP_EXCEEDED',
]);

/** The message returned whenever the real one must not leave the server. */
const OPAQUE_MESSAGE = 'Internal Server Error';

const applyErrorResponse = (ctx: Context, error: unknown, status: number) => {
  ctx.status = status;

  if (error instanceof DomainError) {
    ctx.body = domainErrorBody(error);
    // A windowed refusal's contract includes a `Retry-After` header. The request
    // middleware sets it explicitly; other enforcement points (the token/cost
    // generation gate, a share's cap) rely on this fallback.
    if (RETRY_AFTER_CODES.has(error.code) && !ctx.response.get('Retry-After')) {
      const retryAfter = resetsAtRetryAfterSeconds(error.meta);
      if (retryAfter !== null) ctx.set('Retry-After', String(retryAfter));
    }
    return;
  }

  if (isKoaHttpError(error)) {
    if (error.headers) {
      for (const [key, value] of Object.entries(error.headers)) {
        ctx.set(key, value);
      }
    }

    // `expose` is the framework's judgement about whether the message is safe
    // to return, so it decides both halves. The status stays the framework's —
    // `REQUEST_REJECTED`'s registry `httpStatus` is only the default for
    // throwing it directly.
    ctx.body = error.expose
      ? errorBody({ code: 'REQUEST_REJECTED', message: error.message })
      : errorBody({ code: 'INTERNAL_ERROR', message: OPAQUE_MESSAGE });
    return;
  }

  ctx.body = errorBody({ code: 'INTERNAL_ERROR', message: OPAQUE_MESSAGE });
};

const errorLoggerMiddleware = async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (error_) {
    const error = normalizeError(error_);
    const status = getErrorStatus({ error });

    if (
      isErrorLoggingEnabled() &&
      !(isKoaHttpError(error) && error.status < 500)
    ) {
      writeErrorLog({ ctx, status, error });
    }

    applyErrorResponse(ctx, error, status);
  }
};

export { errorLoggerMiddleware };
