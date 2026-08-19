import { APICallError, NoObjectGeneratedError, RetryError } from 'ai';

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
export const isFetchFailure = (
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
 * The message an OpenAI-compatible provider puts in an error it streams
 * **mid-run** — a `data: {"error": {"message": ...}}` frame rather than a failed
 * request — or `null` when the value is not one of those.
 *
 * The AI SDK forwards that frame's own JSON value to `onError`: nothing threw,
 * the response was already `200`, so there is no `APICallError` to match on. Left
 * unmatched it fell through to the generic wrapper, and a fault the provider had
 * named reached the caller as "Internal Server Error" and the generation record
 * as `[object Object]` (#1084).
 *
 * A real `Error` is deliberately excluded: those are served by
 * `toProviderDomainError`'s earlier branches and by
 * `buildGenerationErrorPayload`, and mapping every one of them to
 * `AI_PROVIDER_ERROR` would relabel failures that never came from the provider.
 * What is left — a bare object carrying a string `message`, optionally wrapped in
 * an `error` key — only reaches this function from a provider stream.
 */
const streamedProviderErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error || typeof error !== 'object' || error === null) {
    return null;
  }
  const payload =
    'error' in error ? (error as { error: unknown }).error : error;
  if (typeof payload !== 'object' || payload === null) return null;
  const { message } = payload as { message?: unknown };
  return typeof message === 'string' ? message : null;
};

/**
 * The `AI_PROVIDER_ERROR` for a failed provider *request*, naming the
 * provider's own status so an unavailable model is distinguishable from a fault
 * in the runtime, and carrying its response body for post-mortem reading.
 */
const apiCallDomainError = (error: APICallError): DomainError => {
  const statusCode = error.statusCode;
  const message = statusCode
    ? `Provider returned ${statusCode}: ${error.message}`
    : `Provider request failed: ${error.message}`;

  return new DomainError('AI_PROVIDER_ERROR', message, {
    ...(statusCode !== undefined && { providerStatusCode: statusCode }),
    ...(error.responseBody !== undefined && {
      providerResponseBody: error.responseBody,
    }),
  });
};

/**
 * Maps an upstream AI provider failure — an `APICallError` thrown by the AI
 * SDK (possibly wrapped in a `RetryError`), a network fault, or an error frame
 * a provider streamed mid-run — to a `AI_PROVIDER_ERROR` `DomainError`
 * (HTTP 502). Returns `null` for errors that did not originate from the
 * provider call, so callers can rethrow them unchanged.
 */
export const toProviderDomainError = (error: unknown): DomainError | null => {
  const unwrapped = unwrapProviderError(error);

  // The model returned something that is not the object the agent's
  // `output_schema` describes — unparseable JSON, or JSON that violates the
  // schema (see `validateStructuredOutput`). Upstream-caused like an
  // `APICallError`, so it belongs on this path: mapping it here covers the
  // initial turn and the tool-outputs continuation at once, since both funnel
  // their failures through this function.
  if (NoObjectGeneratedError.isInstance(unwrapped)) {
    return new DomainError(
      'OUTPUT_SCHEMA_VALIDATION_FAILED',
      `Model output did not satisfy output_schema: ${unwrapped.cause instanceof Error ? unwrapped.cause.message : unwrapped.message}`,
      {
        ...(unwrapped.finishReason !== undefined && {
          finishReason: unwrapped.finishReason,
        }),
      }
    );
  }

  if (APICallError.isInstance(unwrapped)) {
    return apiCallDomainError(unwrapped);
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

  const streamedMessage = streamedProviderErrorMessage(unwrapped);
  if (streamedMessage !== null) {
    return new DomainError(
      'AI_PROVIDER_ERROR',
      `Provider request failed: ${streamedMessage}`
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
