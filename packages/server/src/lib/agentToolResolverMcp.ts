/**
 * Resolving an `mcp` tool binding into AI-SDK tools, and calling one.
 *
 * Split from `agentToolResolverExternalTools.ts`, which held this and the
 * `builtin` (SOAT) resolution: the two share nothing but the shape of the
 * error callback, and together they had grown past the module ceiling. The
 * protocol reading itself lives in `mcpProtocol.ts` and `mcpToolListing.ts`.
 */
import type { JSONSchema7, JSONValue, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';

import {
  type LogToolCallingError,
  SOAT_TOOL_CALL_TIMEOUT_MS,
} from './externalToolCall';
import { parseJsonRpcBody, readMcpCallResult } from './mcpProtocol';
import { fetchMcpToolListing, type McpToolListing } from './mcpToolListing';
import { fetchWithEgressGuard } from './toolEgress';
import {
  mergePresetParameters,
  stripPresetKeysFromSchema,
} from './toolPresetParameters';
import { resolvePresetParametersForCall } from './toolTemplates';

export const buildMcpToolExecute = (args: {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  mcpToolName: string;
  presetParameters?: object | null;
  // A `{{context:}}` token in a preset resolves against this call's context and
  // is retyped by the tool's schema — at call time, so a missing key fails this
  // call rather than the resolution of every tool the agent has (#345).
  toolContext?: Record<string, string>;
  presetSchema?: unknown;
  logToolCallingError: LogToolCallingError;
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
    try {
      const callResponse = await fetchWithEgressGuard(args.mcpUrl, {
        method: 'POST',
        headers: args.mcpHeaders,
        signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: args.mcpToolName, arguments: callArgs },
        }),
      });
      return readMcpCallResult({
        body: await parseJsonRpcBody(callResponse),
        toolName: args.mcpToolName,
        url: args.mcpUrl,
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
  presetParameters?: object | null;
  toolContext?: Record<string, string>;
  logToolCallingError: LogToolCallingError;
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
      presetParameters: args.presetParameters,
      toolContext: args.toolContext,
      presetSchema: mcpTool.inputSchema,
      logToolCallingError: args.logToolCallingError,
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
    // prefixed context headers. `null`/`undefined` forwards all (#945).
    contextKeys?: string[] | null;
    // Fixed values the operator pinned on the binding. They apply to every tool
    // the MCP server exposes through it — the same reach `builtin` presets have
    // over every action a binding lists.
    presetParameters?: object | null;
  };
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

  for (const mcpTool of listing) {
    if (!isBound(mcpTool.name)) continue;
    result[mcpTool.name] = buildMcpToolEntry({
      mcpTool,
      mcpUrl,
      mcpHeaders,
      presetParameters: args.typedTool.presetParameters,
      toolContext: args.toolContext,
      logToolCallingError: args.logToolCallingError,
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
