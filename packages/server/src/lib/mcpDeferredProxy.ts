/**
 * MCP servers that defer their tools behind `search` / `describe` / `call`
 * (the `@ttoss/http-server-mcp` `defer` mode, which SOAT's own `/mcp` and
 * others use). Their `tools/list` names the three proxies, not the tools a
 * binding's `actions` / `denied_actions` mean, so every list is applied to the
 * name inside a `call` — otherwise an allowlist matches nothing and a denylist
 * is bypassed by calling the denied tool through `call`.
 */
import { SOAT_TOOL_CALL_TIMEOUT_MS } from './externalToolCall';
import { parseJsonRpcBody, readMcpCallResult } from './mcpProtocol';
import type { McpToolListing } from './mcpToolListing';
import { isPlainObject } from './plainObject';
import { fetchWithEgressGuard } from './toolEgress';

/** The listed tools a deferred server reaches its catalogue through. */
export type DeferredProxy = { callName: string; describeName: string };

const propertyType = (tool: McpToolListing, name: string): unknown => {
  const properties = tool.inputSchema?.properties;
  const property = isPlainObject(properties) ? properties[name] : undefined;
  return isPlainObject(property) ? property.type : undefined;
};

/**
 * The proxies, recognized by shape rather than name, since a server may rename
 * them: `call` takes a string `name` and an object `arguments`, `describe`
 * takes a `names` array. `null` when the server lists its tools directly.
 */
export const findDeferredProxy = (
  listing: McpToolListing[]
): DeferredProxy | null => {
  const call = listing.find((tool) => {
    return (
      propertyType(tool, 'name') === 'string' &&
      propertyType(tool, 'arguments') === 'object'
    );
  });
  const describe = listing.find((tool) => {
    return propertyType(tool, 'names') === 'array';
  });
  return call && describe
    ? { callName: call.name, describeName: describe.name }
    : null;
};

/** The tool name a deferred `call` targets, if its arguments carry one. */
export const innerToolName = (callArgs: unknown): string | undefined => {
  return isPlainObject(callArgs) && typeof callArgs.name === 'string'
    ? callArgs.name
    : undefined;
};

/**
 * The definitions of `names` behind the proxy. A name the server does not
 * know is simply absent, so a binding naming only unknown tools resolves to
 * nothing — reported like any listing that leaves nothing to attach.
 */
export const describeDeferredTools = async (args: {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  proxy: DeferredProxy;
  names: string[];
}): Promise<McpToolListing[]> => {
  if (args.names.length === 0) return [];
  const response = await fetchWithEgressGuard(args.mcpUrl, {
    method: 'POST',
    headers: args.mcpHeaders,
    signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: args.proxy.describeName,
        arguments: { names: args.names },
      },
    }),
  });
  let described: unknown;
  try {
    described = readMcpCallResult({
      body: await parseJsonRpcBody(response),
      toolName: args.proxy.describeName,
      url: args.mcpUrl,
    });
  } catch {
    // `describe` answers an error when it knows none of the names.
    return [];
  }
  const tools = isPlainObject(described) ? described.tools : undefined;
  return Array.isArray(tools)
    ? tools.filter((tool): tool is McpToolListing => {
        return isPlainObject(tool) && typeof tool.name === 'string';
      })
    : [];
};
