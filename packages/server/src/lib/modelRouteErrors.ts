import { APICallError, RetryError } from 'ai';

import { isFetchFailure } from './providerError';

/**
 * The failover-eligible error classes. This mapping is public contract surface:
 * it defines what a route's `retry_on` values mean and is reported back to
 * callers as `routing.attempts[].error_class` on the Generation.
 */
export const MODEL_ROUTE_ERROR_CLASSES = [
  'provider_error',
  'timeout',
  'rate_limited',
] as const;

export type ModelRouteErrorClass = (typeof MODEL_ROUTE_ERROR_CLASSES)[number];

const unwrapRetryError = (error: unknown): unknown => {
  if (RetryError.isInstance(error)) {
    return error.lastError ?? error;
  }
  return error;
};

/**
 * An abort surfaces as a `DOMException`/`Error` named `AbortError` (an explicit
 * abort) or `TimeoutError` (`AbortSignal.timeout`). Checked structurally
 * because the rejection may originate from undici internals in another realm.
 */
const isAbortLike = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
};

/**
 * Maps a failed LLM call to a failover class, or `null` when the failure is
 * deterministic and must fail fast (400-class, auth, content policy, schema
 * validation) — retrying those on another target burns spend and hides the
 * caller's bug behind a different provider's error message.
 *
 * A caller-initiated abort (the caller's own signal fired) aborts the run and
 * never fails over, even though it looks exactly like a per-target timeout.
 */
export const classifyModelRouteError = (args: {
  error: unknown;
  callerSignal?: AbortSignal;
}): ModelRouteErrorClass | null => {
  if (args.callerSignal?.aborted) return null;

  const error = unwrapRetryError(args.error);

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return 'rate_limited';
    // No status code at all = the request never got a response (connection
    // level). `isRetryable` is the SDK's own provider-shaped verdict.
    if (
      error.statusCode === undefined ||
      error.statusCode >= 500 ||
      error.isRetryable
    ) {
      return 'provider_error';
    }
    return null;
  }

  if (isAbortLike(error)) return 'timeout';
  if (isFetchFailure(error)) return 'provider_error';

  return null;
};
