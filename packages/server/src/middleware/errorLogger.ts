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

const errorLoggerMiddleware = async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (error) {
    const status = getErrorStatus({ error });

    if (isErrorLoggingEnabled()) {
      // eslint-disable-next-line no-console
      console.error('Request failed:', {
        method: ctx.method,
        path: ctx.path,
        status,
        userAgent: ctx.get('user-agent') || undefined,
        error: toErrorText({ error }),
      });
    }

    ctx.status = status;
    ctx.body = { error: 'Internal Server Error' };
  }
};

export { errorLoggerMiddleware };
