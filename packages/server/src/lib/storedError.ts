import { DomainError } from '../errors';
import { ERROR_CODES, type ErrorCode } from '../errors/codes';

/** The `error` a resource records when its work fails, as its `GET` answers it. */
export type StoredError = {
  code: ErrorCode;
  message: string;
  meta?: Record<string, unknown>;
};

/** What an unexpected failure records: the request layer's own answer to one. */
export const INTERNAL_FAILURE: StoredError = {
  code: 'INTERNAL_ERROR',
  message: 'Internal Server Error',
};

/** Whether `code` is a key of the `ERROR_CODES` registry. */
export const isErrorCode = (code: string): code is ErrorCode => {
  return Object.hasOwn(ERROR_CODES, code);
};

const fromDomainError = (error: DomainError): StoredError => {
  return {
    code: error.code,
    message: error.message,
    ...(error.meta !== undefined && { meta: error.meta }),
  };
};

/**
 * A thrown value as a resource records it. A `DomainError` keeps its code,
 * message and meta, the three a request's error body carries; anything else
 * records `opaque`, and its raw form reaches the log only, as a request never
 * forwards an unexpected error's message either. A failure a caller can act on
 * is raised as a `DomainError` where it happens, so it never lands here raw.
 *
 * Logged through `console.error` rather than `debug`, which is off in
 * production: the log is the only place the detail survives.
 */
export const toStoredError = (args: {
  error: unknown;
  opaque: StoredError;
  label: string;
}): StoredError => {
  const { error } = args;
  if (error instanceof DomainError) return fromDomainError(error);
  // eslint-disable-next-line no-console
  console.error(`${args.label}: recorded as ${args.opaque.code}`, error);
  return args.opaque;
};

/**
 * A thrown value as a resource records it where the failure's own words are
 * part of the record a caller debugs from: a `DomainError` as
 * {@link toStoredError} keeps it, any other error under `code` with its own
 * message, and a value with no message under `code` with the code's
 * description.
 */
export const toStoredErrorKeepingMessage = (args: {
  error: unknown;
  code: ErrorCode;
}): StoredError => {
  const { error, code } = args;
  if (error instanceof DomainError) return fromDomainError(error);
  if (error instanceof Error && error.message) {
    return { code, message: error.message };
  }
  if (typeof error === 'string' && error.length > 0) {
    return { code, message: error };
  }
  return { code, message: ERROR_CODES[code].description };
};
