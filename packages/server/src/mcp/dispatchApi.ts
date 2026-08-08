import { AsyncLocalStorage } from 'node:async_hooks';

import { dispatchApiRequestOrThrow } from '../lib/inProcessApi';

/**
 * Tracks the caller's bearer token for the lifetime of a single MCP request so
 * a tool handler can forward it without threading it through every registration.
 * Populated via `enterWith` from `getApiHeaders` in `mcp/server.ts`, which runs
 * synchronously before the tool handler's async chain, so the store scopes
 * correctly per request.
 *
 * A handler registered through `registerToolFromSchema` receives only the tool's
 * arguments — there is no Koa context to read the credential from — so this
 * store is the seam that carries it. Note what it deliberately does **not** do:
 * supply a default. A tool call that arrives without a credential dispatches
 * without one and is refused by the same auth middleware that refused it over
 * the wire. Sharing a process never implies sharing authority.
 */
export const mcpAuthorizationStore = new AsyncLocalStorage<string>();

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
 * This used to `fetch` `http://localhost:$PORT` — the server calling itself
 * over the network to reuse the route handler's permission checks and
 * snake_case boundary (#888, extended from the agent-side `soat` tool to the
 * MCP surface). `dispatchApiRequestOrThrow` runs the app's real middleware
 * chain instead, so every reason the hop existed still holds — the same auth
 * middleware, permission evaluation, strict-field validation, audit record,
 * metering, and response contract — while the socket, the JSON round trip, and
 * the requirement that the process be listening on a port at all are gone.
 *
 * The thrown-`Error` contract is what MCP needs and why this wrapper exists at
 * all: `@ttoss/http-server-mcp`'s own `apiCall` builds its error via
 * `new Error(err.error)`, which stringifies a `DomainError`'s `{ code, message }`
 * body to the literal `"[object Object]"`. Here the real message reaches the
 * client.
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
    headers: { authorization: mcpAuthorizationStore.getStore() ?? '' },
    body: args.body,
    wrapError: (response) => {
      return new Error(
        extractApiErrorMessage(response.body) ?? `HTTP ${response.status}`
      );
    },
  });
};
