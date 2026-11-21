import {
  ApiError,
  errorBodyMessage,
  getApiHeaders,
} from '@ttoss/http-server-mcp';

import { dispatchApiRequestOrThrow } from '../lib/inProcessApi';

/**
 * Serves one REST-backed MCP tool call against this process's own app.
 *
 * `dispatchApiRequestOrThrow` runs the app's real middleware chain in-process,
 * so the call reuses the route handler's permission checks and snake_case
 * boundary without a socket, a JSON round trip, or a listening port.
 *
 * A non-2xx answer throws `ApiError`, which `registerTools` answers as an
 * `isError` result: `errorBodyMessage`'s `CODE: message` line as text and the
 * REST envelope as `structuredContent`.
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
    as: { authorization: getApiHeaders().authorization ?? '' },
    body: args.body,
    wrapError: (response) => {
      return new ApiError({
        message: errorBodyMessage(response.body) ?? `HTTP ${response.status}`,
        status: response.status,
        body: response.body,
      });
    },
  });
};
