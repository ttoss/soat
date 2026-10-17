/**
 * The `tools/list` half of resolving an `mcp` binding: everything that can fail
 * before there is a surface to build.
 *
 * Split from `agentToolResolverMcp.ts` when pagination made it the larger half
 * of that file.
 */
import type { JSONValue } from 'ai';

import { jsonRpcErrorReason, parseJsonRpcBody } from './mcpProtocol';
import { type McpTransport, postMcp } from './mcpTransport';
import { isPlainObject } from './plainObject';

/**
 * One tool as `tools/list` describes it. Every field the protocol defines is
 * carried, including the ones only the resolved `Tool` reads: a server that
 * declares its own tool destructive is stating something the gating mechanisms
 * above can use, and dropping it here is where that statement would be lost.
 */
export type McpToolListing = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, JSONValue>;
  _meta?: Record<string, JSONValue>;
};

/**
 * A listing is paginated by an opaque `nextCursor`; a server that sends one and
 * is never asked again has silently published a fraction of its surface. The
 * page budget bounds a server whose cursor never terminates — a repeated cursor
 * is the same loop and stops immediately.
 */
const MAX_LISTING_PAGES = 100;

type ListingPage = { tools: McpToolListing[]; nextCursor: string | null };

const readListingPage = (body: unknown): ListingPage | { failure: string } => {
  const errorReason = jsonRpcErrorReason({ body, method: 'tools/list' });
  if (errorReason !== null) return { failure: errorReason };

  const result = isPlainObject(body) ? body.result : undefined;
  const tools = isPlainObject(result) ? result.tools : undefined;
  if (!Array.isArray(tools)) {
    return { failure: 'tools/list answered 200 with no `result.tools` array' };
  }

  const nextCursor = isPlainObject(result) ? result.nextCursor : undefined;
  return {
    tools: tools.filter((entry): entry is McpToolListing => {
      return isPlainObject(entry) && typeof entry.name === 'string';
    }),
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
  };
};

const requestListingPage = async (args: {
  transport: McpTransport;
  cursor: string | null;
  id: number;
}): Promise<ListingPage | { failure: string }> => {
  const response = await postMcp({
    transport: args.transport,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: args.id,
      method: 'tools/list',
      ...(args.cursor === null ? {} : { params: { cursor: args.cursor } }),
    }),
  });

  if (!response.ok) {
    return { failure: `tools/list answered ${response.status}` };
  }
  return readListingPage(await parseJsonRpcBody(response));
};

/**
 * Every page of the server's catalogue. `null` is "no listing" — unreachable,
 * refused, or an answer this could not be read out of — which the caller
 * reports; an empty array is a server that really exposes nothing.
 *
 * A page that fails after earlier pages succeeded is still a failure: a partial
 * catalogue is a turn missing tools the agent is configured to have, which is
 * the outcome that must never be silent.
 */
export const fetchMcpToolListing = async (args: {
  transport: McpTransport;
  logToolCallingError: (args: {
    toolName: string;
    toolType: 'mcp';
    url?: string;
    method?: string;
    error: unknown;
  }) => void;
  reportResolutionFailure?: (args: { reason: string }) => void;
}): Promise<McpToolListing[] | null> => {
  try {
    const tools: McpToolListing[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
      const listing: ListingPage | { failure: string } =
        await requestListingPage({
          transport: args.transport,
          cursor,
          id: page + 1,
        });
      if ('failure' in listing) {
        args.reportResolutionFailure?.({ reason: listing.failure });
        return null;
      }

      tools.push(...listing.tools);
      if (listing.nextCursor === null) return tools;
      if (seenCursors.has(listing.nextCursor)) return tools;
      seenCursors.add(listing.nextCursor);
      cursor = listing.nextCursor;
    }

    args.reportResolutionFailure?.({
      reason: `tools/list paginated past ${MAX_LISTING_PAGES} pages`,
    });
    return null;
  } catch (error) {
    args.logToolCallingError({
      toolName: args.transport.url,
      toolType: 'mcp',
      url: args.transport.url,
      method: 'POST',
      error,
    });
    args.reportResolutionFailure?.({
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};
