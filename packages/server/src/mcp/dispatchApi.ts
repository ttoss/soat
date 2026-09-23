import { getApiHeaders } from '@ttoss/http-server-mcp';

import { dispatchApiRequestOrThrow } from '../lib/inProcessApi';

/**
 * Extracts a human-readable message from a REST API error response body.
 *
 * The body shape varies by error type (see `.claude/rules/errors.md`):
 * - `DomainError` responses: `{ error: { code, message, meta? } }`
 * - Generic/manual error responses: `{ error: "some string" }`
 *
 * Returns `null` when no readable message can be extracted, so callers can
 * fall back to a generic message instead of stringifying an object.
 */
export const extractApiErrorMessage = (body: unknown): string | null => {
  if (!body || typeof body !== 'object' || !('error' in body)) return null;

  const error = (body as { error: unknown }).error;

  if (typeof error === 'string') return error;

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  return null;
};

/**
 * Serves one REST-backed MCP tool call against this process's own app.
 *
 * `dispatchApiRequestOrThrow` runs the app's real middleware chain in-process,
 * so the call reuses the route handler's permission checks and snake_case
 * boundary without a socket, a JSON round trip, or a listening port.
 *
 * The thrown-`Error` contract is why this wrapper exists at all:
 * `@ttoss/http-server-mcp`'s own `apiCall` builds its error via
 * `new Error(err.error)`, which stringifies a `DomainError` body to
 * `"[object Object]"`. Here the real message reaches the client.
 */
export const dispatchMcpApiRequest = async (args: {
  method: string;
  /** Path plus any query string, e.g. `/api/v1/agents/agt_1`. */
  url: string;
  body?: unknown;
}): Promise<unknown> => {
  return dispatchApiRequestOrThrow({
    method: args.method,
    path: args.url,
    // The caller's credential for this MCP request, with no default: a call
    // that arrives without one is refused by the same auth middleware that
    // refuses it over the wire. Sharing a process never implies sharing authority.
    headers: { authorization: getApiHeaders().authorization ?? '' },
    body: args.body,
    wrapError: (response) => {
      return new Error(
        extractApiErrorMessage(response.body) ?? `HTTP ${response.status}`
      );
    },
  });
};
