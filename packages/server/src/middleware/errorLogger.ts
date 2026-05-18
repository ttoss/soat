import { inspect } from 'node:util';

import { DatabaseError } from '@ttoss/postgresdb';
import { APICallError } from 'ai';

import { AppError } from '../AppError';
import type { Context } from '../Context';

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

const getErrorStatus = (args: { error: unknown }) => {
  if (
    typeof args.error === 'object' &&
    args.error !== null &&
    'status' in args.error &&
    typeof args.error.status === 'number'
  ) {
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

const errorLoggerMiddleware = async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (error) {
    const status = getErrorStatus({ error });

    if (isErrorLoggingEnabled()) {
      const causeToLog =
        error instanceof AppError ? (error.cause ?? error) : error;
      writeErrorLog({
        ctx,
        status,
        error: causeToLog,
      });
    }

    ctx.status = status;
    ctx.body = {
      error:
        error instanceof AppError ? error.message : 'Internal Server Error',
    };
  }
};

export { errorLoggerMiddleware };
