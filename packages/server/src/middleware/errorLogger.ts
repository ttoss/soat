import { inspect } from 'node:util';

import { DatabaseError } from '@ttoss/postgresdb';
import { APICallError } from 'ai';

import type { Context } from '../Context';
import { DomainError, type ErrorCode } from '../errors';

type Next = () => Promise<void>;

const isErrorLoggingEnabled = () => {
  const value = process.env.SOAT_ERROR_LOGS_ENABLED;

  if (value === undefined) {
    return true;
  }

  return !['false', '0', 'off', 'no'].includes(value.toLowerCase());
};

const toErrorText = (args: { error: unknown }) => {
  if (args.error instanceof Error) {
    return args.error.stack ?? args.error.message;
  }

  return String(args.error);
};

const toApiCallErrorDetails = (
  error: unknown
): Record<string, unknown> | undefined => {
  if (error instanceof APICallError) {
    return {
      url: error.url,
      statusCode: error.statusCode,
      responseBody: error.responseBody,
    };
  }

  return undefined;
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
    return {
      sql: error.sql,
      parameters: error.parameters,
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
 * parseable as the declared content type.
 *
 * It carries `status = 400` and the offending payload as `body`, but **not**
 * `expose`, so `isKoaHttpError` rejects it and the request answered `500` with
 * `{"error":"Internal Server Error"}` — blaming the server for a malformed
 * client request, and in the one response shape a client cannot branch on.
 * `POST` with `Content-Type: application/json` and a body of `null` reproduces
 * it on any route.
 *
 * Recognised here rather than guarded at each parse site because this middleware
 * is the single place that maps an error to a response — the same reason the
 * route handlers stopped writing error bodies of their own.
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
    userAgent: args.ctx.get('user-agent') || undefined,
    error: toErrorText({ error: args.error }),
    ...toApiCallErrorDetails(args.error),
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

// Seconds until a quota window resets, from the `resets_at` carried in a
// QUOTA_EXCEEDED error's meta. Null when the meta has no usable timestamp.
const quotaRetryAfterSeconds = (
  meta: Record<string, unknown> | undefined
): number | null => {
  const resetsAt = meta?.resets_at;
  if (typeof resetsAt !== 'string') return null;
  const ms = new Date(resetsAt).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
};

/** The message returned whenever the real one must not leave the server. */
const OPAQUE_MESSAGE = 'Internal Server Error';

/**
 * The response body, in the one shape the API has: `{ error: { code, message,
 * meta? } }`.
 *
 * Every branch below routes through here, the catch-all included. A response a
 * caller cannot parse the same way as every other response is the branch #913
 * set out to delete, and the catch-all is the worst place to leave one — it is
 * the response that arrives unannounced, so it is the one a client is least
 * likely to have special-cased.
 */
const errorBody = (args: {
  code: ErrorCode;
  message: string;
  meta?: Record<string, unknown>;
}) => {
  return {
    error: {
      code: args.code,
      message: args.message,
      ...(args.meta !== undefined && { meta: args.meta }),
    },
  };
};

const applyErrorResponse = (ctx: Context, error: unknown, status: number) => {
  ctx.status = status;

  if (error instanceof DomainError) {
    ctx.body = errorBody({
      code: error.code,
      message: error.message,
      meta: error.meta,
    });
    // The QUOTA_EXCEEDED contract includes a `Retry-After` header. The request
    // middleware sets it explicitly; other enforcement points (the token/cost
    // generation gate) rely on this fallback so every breach honors it.
    if (error.code === 'QUOTA_EXCEEDED' && !ctx.response.get('Retry-After')) {
      const retryAfter = quotaRetryAfterSeconds(error.meta);
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

    // `expose` is the framework's own judgement about whether the message is
    // safe to return, so it decides both halves: an exposed rejection keeps its
    // reason, an unexposed one is indistinguishable from any other 500. The
    // status stays the framework's — `REQUEST_REJECTED` labels the class, and
    // its registry `httpStatus` is only the default for throwing it directly.
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
