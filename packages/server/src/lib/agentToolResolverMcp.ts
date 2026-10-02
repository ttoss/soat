/**
 * Resolving an `mcp` tool binding into AI-SDK tools, and calling one.
 *
 * Separate from `agentToolResolverExternalTools.ts`, which holds the `builtin`
 * (SOAT) resolution: the two share nothing but the shape of the error callback,
 * and together they exceed the module ceiling. The protocol reading itself
 * lives in `mcpProtocol.ts` and `mcpToolListing.ts`.
 */
import type { JSONSchema7, JSONValue, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';

import {
  type LogToolCallingError,
  SOAT_TOOL_CALL_TIMEOUT_MS,
} from './externalToolCall';
import {
  type DeferredProxy,
  describeDeferredTools,
  findDeferredProxy,
  innerToolName,
} from './mcpDeferredProxy';
import { parseJsonRpcBody, readMcpCallResult } from './mcpProtocol';
import { fetchMcpToolListing, type McpToolListing } from './mcpToolListing';
import { fetchWithEgressGuard } from './toolEgress';
import {
  mergePresetParameters,
  stripPresetKeysFromSchema,
} from './toolPresetParameters';
import { resolvePresetParametersForCall } from './toolTemplates';
import {
  meterToolExecution,
  type ToolExecutionMeter,
} from './usageToolRecording';

export const buildMcpToolExecute = (args: {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  mcpToolName: string;
  meter: ToolExecutionMeter;
  presetParameters?: object | null;
  // A `{{context:}}` token in a preset resolves against this call's context and
  // is retyped by the tool's schema — at call time, so a missing key fails this
  // call rather than the resolution of every tool the agent has.
  toolContext?: Record<string, string>;
  presetSchema?: unknown;
  logToolCallingError: LogToolCallingError;
  /** Sends the call through a deferred server's proxy; see `mcpDeferredProxy.ts`. */
  viaCall?: string;
  /** On a deferred server's own `call`: whether the tool it targets is bound. */
  allowInner?: (name: string) => boolean;
}) => {
  return async (toolArgs: unknown) => {
    const presetParameters = resolvePresetParametersForCall({
      presetParameters: args.presetParameters,
      toolContext: args.toolContext,
      toolName: args.mcpToolName,
      schema: args.presetSchema,
    });
    const callArgs = presetParameters
      ? mergePresetParameters({ presetParameters, input: toolArgs })
      : toolArgs;
    if (args.allowInner) {
      const inner = innerToolName(callArgs);
      if (inner === undefined || !args.allowInner(inner)) {
        throw new Error(
          `action "${inner ?? ''}" is not available on this tool.`
        );
      }
    }
    try {
      return await meterToolExecution({
        meter: args.meter,
        send: async (markSent) => {
          const callResponse = await fetchWithEgressGuard(
            args.mcpUrl,
            {
              method: 'POST',
              headers: args.mcpHeaders,
              signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: args.viaCall
                  ? {
                      name: args.viaCall,
                      arguments: {
                        name: args.mcpToolName,
                        arguments: callArgs,
                      },
                    }
                  : { name: args.mcpToolName, arguments: callArgs },
              }),
            },
            {
              onRequest: () => {
                markSent({ input: callArgs });
              },
            }
          );
          return readMcpCallResult({
            body: await parseJsonRpcBody(callResponse),
            toolName: args.mcpToolName,
            url: args.mcpUrl,
          });
        },
      });
    } catch (error) {
      args.logToolCallingError({
        toolName: args.mcpToolName,
        toolType: 'mcp',
        url: args.mcpUrl,
        method: 'POST',
        error,
      });
      throw error;
    }
  };
};

/**
 * What the server says about the tool that the model is not shown.
 *
 * The AI SDK sends the provider `name`, `description` and `inputSchema` only,
 * so this rides along on the resolved tool and onto its call parts — which is
 * where a gating mechanism reading `annotations.destructiveHint` would look.
 */
const toolMetadata = (
  mcpTool: McpToolListing
): Record<string, JSONValue> | undefined => {
  const metadata = {
    ...(mcpTool.annotations ? { annotations: mcpTool.annotations } : {}),
    ...(mcpTool._meta ? { meta: mcpTool._meta } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

/** One listed MCP tool, as the model sees it and as it dispatches. */
const buildMcpToolEntry = (args: {
  mcpTool: McpToolListing;
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  meter: ToolExecutionMeter;
  presetParameters?: object | null;
  toolContext?: Record<string, string>;
  logToolCallingError: LogToolCallingError;
  viaCall?: string;
  allowInner?: (name: string) => boolean;
}): Tool => {
  const { mcpTool } = args;
  const entry = {
    description: mcpTool.description ?? undefined,
    title: mcpTool.title,
    metadata: toolMetadata(mcpTool),
    inputSchema: jsonSchema(
      stripPresetKeysFromSchema(
        (mcpTool.inputSchema ?? {
          type: 'object',
          properties: {},
        }) as JSONSchema7,
        args.presetParameters
      )
    ),
    execute: buildMcpToolExecute({
      mcpUrl: args.mcpUrl,
      mcpHeaders: args.mcpHeaders,
      mcpToolName: mcpTool.name,
      meter: args.meter,
      presetParameters: args.presetParameters,
      toolContext: args.toolContext,
      presetSchema: mcpTool.inputSchema,
      logToolCallingError: args.logToolCallingError,
      viaCall: args.viaCall,
      allowInner: args.allowInner,
    }),
  };

  // Two calls rather than an optional key: `outputSchema` is what the SDK
  // infers a tool's output type from, and an `outputSchema: undefined` in the
  // literal makes that inference `never`.
  return mcpTool.outputSchema
    ? tool({
        ...entry,
        outputSchema: jsonSchema<unknown>(mcpTool.outputSchema as JSONSchema7),
      })
    : tool(entry);
};

/** The binding's allowlist and denylist, as one predicate over tool names. */
const buildActionFilter = (typedTool: {
  actions?: string[] | null;
  deniedActions?: string[] | null;
}): ((name: string) => boolean) => {
  const allowed = typedTool.actions != null ? new Set(typedTool.actions) : null;
  const denied =
    typedTool.deniedActions != null ? new Set(typedTool.deniedActions) : null;
  return (name) => {
    if (allowed && !allowed.has(name)) return false;
    return !denied?.has(name);
  };
};

/**
 * The tools a binding attaches. On a deferred server an allowlist names tools
 * behind the proxy, so those are described and attached by name, and the
 * proxies themselves are not; without one, the listing is attached as listed
 * and its `call` checks each target against the binding (`allowInner`).
 */
const boundTools = async (args: {
  listing: McpToolListing[];
  proxy: DeferredProxy | null;
  actions?: string[] | null;
  isBound: (name: string) => boolean;
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
}): Promise<McpToolListing[]> => {
  const listed = args.listing.filter((mcpTool) => {
    return args.isBound(mcpTool.name);
  });
  if (!args.proxy || args.actions == null) return listed;

  const listedNames = new Set(
    args.listing.map((mcpTool) => {
      return mcpTool.name;
    })
  );
  const behindProxy = await describeDeferredTools({
    mcpUrl: args.mcpUrl,
    mcpHeaders: args.mcpHeaders,
    proxy: args.proxy,
    names: args.actions.filter((name) => {
      return !listedNames.has(name);
    }),
  });
  const proxyNames = new Set([args.proxy.callName, args.proxy.describeName]);
  return [
    ...listed.filter((mcpTool) => {
      return !proxyNames.has(mcpTool.name);
    }),
    ...behindProxy.filter((mcpTool) => {
      return args.isBound(mcpTool.name);
    }),
  ];
};

export const resolveMcpTools = async (args: {
  typedTool: {
    mcp: { url: string; headers?: Record<string, string> };
    // Absent exposes the whole MCP surface. A set is the capability-level
    // primitive that makes a read-only scope over a read+write server
    // enforceable, not just a prompt-level suggestion.
    actions?: string[] | null;
    // Applied after, and taking precedence over, the allowlist. The ergonomic
    // way to scope a read+write server read-only: deny the write tools instead
    // of enumerating every read tool.
    deniedActions?: string[] | null;
    // Per-tool allowlist of `tool_context` keys that may be forwarded as
    // prefixed context headers. `null`/`undefined` forwards all.
    contextKeys?: string[] | null;
    // Fixed values the operator pinned on the binding. They apply to every tool
    // the MCP server exposes through it — the same reach `builtin` presets have
    // over every action a binding lists.
    presetParameters?: object | null;
  };
  meter: ToolExecutionMeter;
  toolContext?: Record<string, string>;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  logToolCallingError: LogToolCallingError;
  /**
   * Called when the binding contributed no tool to the turn — the listing could
   * not be obtained, or it was obtained and left nothing to attach. Reporting,
   * not control: an unreachable server still yields an empty surface rather
   * than failing the turn, but a turn that ran without its tools must not be
   * indistinguishable from one that had none to begin with.
   */
  reportResolutionFailure?: (args: { reason: string }) => void;
}): Promise<Record<string, Tool>> => {
  const result: Record<string, Tool> = {};
  const isBound = buildActionFilter(args.typedTool);
  const mcpUrl = args.typedTool.mcp.url;
  const mcpHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...args.typedTool.mcp.headers,
    ...args.buildContextHeaders({
      toolContext: args.toolContext,
      contextKeys: args.typedTool.contextKeys,
    }),
  };

  const listing = await fetchMcpToolListing({
    mcpUrl,
    mcpHeaders,
    logToolCallingError: args.logToolCallingError,
    reportResolutionFailure: args.reportResolutionFailure,
  });
  if (!listing) return result;

  const shared = {
    mcpUrl,
    mcpHeaders,
    meter: args.meter,
    presetParameters: args.typedTool.presetParameters,
    toolContext: args.toolContext,
    logToolCallingError: args.logToolCallingError,
  };
  const proxy = findDeferredProxy(listing);
  for (const mcpTool of await boundTools({
    listing,
    proxy,
    actions: args.typedTool.actions,
    isBound,
    mcpUrl,
    mcpHeaders,
  })) {
    result[mcpTool.name] = buildMcpToolEntry({
      ...shared,
      mcpTool,
      ...(proxy && !listing.includes(mcpTool)
        ? { viaCall: proxy.callName }
        : {}),
      ...(proxy && mcpTool.name === proxy.callName
        ? { allowInner: isBound }
        : {}),
    });
  }

  // A readable listing that leaves nothing to attach is not a transport
  // failure, but the turn still runs without the tools the agent is configured
  // to have — the one outcome that must never be silent.
  if (Object.keys(result).length === 0) {
    args.reportResolutionFailure?.({
      reason:
        listing.length === 0
          ? 'tools/list returned no tools'
          : `every tool tools/list returned was excluded by the binding's actions/denied_actions`,
    });
  }

  return result;
};
