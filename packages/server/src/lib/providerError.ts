import { APICallError, RetryError } from 'ai';

import { DomainError } from '../errors';

const unwrapProviderError = (error: unknown): unknown => {
  if (RetryError.isInstance(error)) {
    return error.lastError ?? error;
  }
  return error;
};

/**
 * Detects network-level fetch failures (e.g. ECONNREFUSED, DNS errors).
 * Checked structurally rather than via `instanceof TypeError` because the
 * error may originate from a different JS realm (undici internals).
 */
const isFetchFailure = (
  error: unknown
): error is { name: string; message: string } => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === 'TypeError' &&
    typeof candidate.message === 'string' &&
    /fetch failed|failed to fetch/i.test(candidate.message)
  );
};

/**
 * Maps an upstream AI provider failure (an `APICallError` thrown by the AI
 * SDK, possibly wrapped in a `RetryError`) to a `AI_PROVIDER_ERROR`
 * `DomainError` (HTTP 502). Returns `null` for errors that did not originate
 * from the provider call, so callers can rethrow them unchanged.
 */
export const toProviderDomainError = (error: unknown): DomainError | null => {
  const unwrapped = unwrapProviderError(error);

  if (APICallError.isInstance(unwrapped)) {
    const statusCode = unwrapped.statusCode;
    const message = statusCode
      ? `Provider returned ${statusCode}: ${unwrapped.message}`
      : `Provider request failed: ${unwrapped.message}`;

    return new DomainError('AI_PROVIDER_ERROR', message, {
      ...(statusCode !== undefined && { providerStatusCode: statusCode }),
      ...(unwrapped.responseBody !== undefined && {
        providerResponseBody: unwrapped.responseBody,
      }),
    });
  }

  if (RetryError.isInstance(error)) {
    return new DomainError(
      'AI_PROVIDER_ERROR',
      `Provider request failed: ${error.message}`
    );
  }

  if (isFetchFailure(unwrapped)) {
    return new DomainError(
      'AI_PROVIDER_ERROR',
      `Provider request failed: ${unwrapped.message}`
    );
  }

  return null;
};

/**
 * Builds the structured error payload persisted on failed generations and
 * traces.
 */
export const buildGenerationErrorPayload = (
  error: unknown
): Record<string, unknown> => {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.meta !== undefined && { meta: error.meta }),
    };
  }

  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }

  return { message: String(error) };
};
