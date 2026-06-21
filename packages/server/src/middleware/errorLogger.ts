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
