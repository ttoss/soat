import { APICallError, RetryError, StreamProviderError } from 'ai';

import { DomainError } from '../errors';
import { HttpToolError } from './httpToolError';

/** A vendor failure, whose message is read from the vendor's response body. */
const vendorFailure = (error: unknown): Record<string, unknown> | null => {
  if (error instanceof HttpToolError) {
    return { name: error.name, status: error.status, method: error.method };
  }
  if (APICallError.isInstance(error)) {
    return {
      name: error.name,
      url: error.url,
      statusCode: error.statusCode,
      isRetryable: error.isRetryable,
    };
  }
  if (StreamProviderError.isInstance(error)) {
    return { name: error.name, statusCode: error.statusCode };
  }
  return null;
};

/**
 * A thrown value as a log line may carry it: only what the server wrote.
 *
 * A `DomainError`'s message and `meta` values can quote a payload another party
 * wrote (a tool target's body, an MCP server's failure, a provider's answer),
 * so the log names its code, status and `meta` keys. A tool target's or a
 * provider's error message is read from its response body, so it is named by
 * status and URL only. Any other error is the server's own and keeps its text and
 * stack; a thrown object that is not an error names its keys only.
 */
export const loggableError = (error: unknown): unknown => {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      status: error.httpStatus,
      metaKeys: Object.keys(error.meta ?? {}),
    };
  }
  if (RetryError.isInstance(error)) {
    return {
      name: error.name,
      reason: error.reason,
      lastError: loggableError(error.lastError),
    };
  }
  const vendor = vendorFailure(error);
  if (vendor) return vendor;
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === 'object' && error !== null) {
    return { keys: Object.keys(error) };
  }
  return String(error);
};
