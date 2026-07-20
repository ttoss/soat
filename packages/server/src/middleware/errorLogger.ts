import { inspect } from 'node:util';

import { DatabaseError } from '@ttoss/postgresdb';
import { APICallError } from 'ai';

import type { Context } from '../Context';
import { DomainError } from '../errors';

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

const applyErrorResponse = (ctx: Context, error: unknown, status: number) => {
  ctx.status = status;

  if (error instanceof DomainError) {
    ctx.body = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.meta !== undefined && { meta: error.meta }),
      },
    };
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
    ctx.body = {
      error: error.expose ? error.message : 'Internal Server Error',
    };
    return;
  }

  ctx.body = { error: 'Internal Server Error' };
};

const errorLoggerMiddleware = async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (error) {
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
