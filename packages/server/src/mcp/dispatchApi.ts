import { getApiHeaders } from '@ttoss/http-server-mcp';

import { dispatchApiRequestOrThrow } from '../lib/inProcessApi';
import { isPlainObject } from '../lib/plainObject';

/**
 * Whether a REST error response carries a readable message. Every non-2xx body
 * is written by `middleware/errorLogger.ts`, whose only shape is
 * `{ error: { code, message, ... } }` (`.claude/rules/errors.md`).
 */
const hasErrorMessage = (
  body: unknown
): body is { error: { message: string } } => {
  return (
    isPlainObject(body) &&
    isPlainObject(body.error) &&
    typeof body.error.message === 'string'
  );
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
        hasErrorMessage(response.body)
          ? response.body.error.message
          : `HTTP ${response.status}`
      );
    },
  });
};
