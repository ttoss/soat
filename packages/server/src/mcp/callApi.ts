import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tracks the caller's bearer token for the lifetime of a single MCP request so
 * `callApi` can forward it without threading it through every tool handler.
 * Populated via `enterWith` from `getApiHeaders` in `mcp/server.ts`, which runs
 * synchronously before the tool handler's async chain, so the store scopes
 * correctly per request.
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
 * Minimal REST client for MCP tool handlers, used instead of
 * `@ttoss/http-server-mcp`'s `apiCall`. `apiCall` builds its thrown `Error`
 * via `new Error(err.error)`, which silently stringifies a `DomainError`'s
 * `{ code, message }` body to the literal `"[object Object]"` — this
 * implementation extracts the real message instead.
 */
export const callApi = async (args: {
  apiBaseUrl: string;
  method: string;
  url: string;
  body?: unknown;
}): Promise<unknown> => {
  const authorization = mcpAuthorizationStore.getStore() ?? '';
  const headers: Record<string, string> = { authorization };
  if (args.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${args.apiBaseUrl}${args.url}`, {
    method: args.method,
    headers,
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });

  if (!response.ok) {
    const parsed = await response.json().catch(() => {
      return null;
    });
    throw new Error(
      extractApiErrorMessage(parsed) ?? `HTTP ${response.status}`
    );
  }

  if (response.status === 204 || response.status === 205) return undefined;
  if (response.headers.get('content-type')?.includes('application/json')) {
    return response.json();
  }
  return response.text();
};
