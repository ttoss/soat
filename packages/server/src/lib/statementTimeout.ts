import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';

/** A positive integer from `env`, else `fallback`. */
export const timeoutFromEnv = (args: {
  env: string;
  fallback: number;
}): number => {
  const raw = Number(process.env[args.env]);
  return Number.isInteger(raw) && raw > 0 ? raw : args.fallback;
};

/** Postgres' `query_canceled`, raised when `statement_timeout` fires. */
const QUERY_CANCELED = '57014';

const isQueryCanceled = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    'parent' in error &&
    error.parent instanceof Error &&
    'code' in error.parent &&
    error.parent.code === QUERY_CANCELED
  );
};

/**
 * Runs `run` in a transaction whose every statement is cancelled past
 * `timeoutMs`, and answers a cancellation as `QUERY_TIMEOUT`. `SET LOCAL`
 * because a plain `SET` would leak onto the pooled connection.
 */
export const withStatementTimeout = async <T>(args: {
  timeoutMs: number;
  message: string;
  run: (options: { transaction: Transaction }) => Promise<T>;
}): Promise<T> => {
  try {
    return await db.sequelize.transaction(async (transaction) => {
      await db.sequelize.query(
        `SET LOCAL statement_timeout = ${Math.trunc(args.timeoutMs)}`,
        { transaction }
      );
      return args.run({ transaction });
    });
  } catch (error) {
    if (!isQueryCanceled(error)) throw error;
    throw new DomainError('QUERY_TIMEOUT', args.message, {
      timeout_ms: args.timeoutMs,
    });
  }
};
