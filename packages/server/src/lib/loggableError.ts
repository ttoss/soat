import { APICallError, RetryError, StreamProviderError } from 'ai';

import { DomainError } from '../errors';
import { HttpToolError } from './httpToolError';

/**
 * A thrown value as a log line may carry it: only what the server wrote.
 *
 * A `DomainError`'s message and `meta` values can quote a payload another party
 * wrote (a tool target's body, an MCP server's failure, a provider's answer),
 * so the log names its code, status and `meta` keys. A tool target's or a
 * provider's error message is read from its response body, so it is named by
 * status and URL only. Any other error is the server's own and keeps its text and
 * stack.
 */
export const loggableError = (error: unknown): unknown => {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      status: error.httpStatus,
      metaKeys: Object.keys(error.meta ?? {}),
    };
  }
  if (error instanceof HttpToolError) {
    return { name: error.name, status: error.status, method: error.method };
  }
  if (RetryError.isInstance(error)) {
    return {
      name: error.name,
      reason: error.reason,
      lastError: loggableError(error.lastError),
    };
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
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
};
