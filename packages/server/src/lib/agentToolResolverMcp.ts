/**
 * Resolving an `mcp` tool binding into AI-SDK tools, and calling one.
 *
 * Split from `agentToolResolverExternalTools.ts`, which held this and the
 * `builtin` (SOAT) resolution: the two share nothing but the shape of the
 * error callback, and together they had grown past the module ceiling.
 */
import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';

import {
  type LogToolCallingError,
  SOAT_TOOL_CALL_TIMEOUT_MS,
} from './externalToolCall';
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
      const callBody = (await callResponse.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = callBody.result?.content?.[0]?.text;
      if (!text) return callBody;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
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

/** One listed MCP tool, as the model sees it and as it dispatches. */
const buildMcpToolEntry = (args: {
  mcpTool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  presetParameters?: object | null;
  toolContext?: Record<string, string>;
  logToolCallingError: LogToolCallingError;
}): Tool => {
  return tool({
    description: args.mcpTool.description ?? undefined,
    inputSchema: jsonSchema(
      stripPresetKeysFromSchema(
        (args.mcpTool.inputSchema ?? {
          type: 'object',
          properties: {},
        }) as JSONSchema7,
        args.presetParameters
      )
    ),
    execute: buildMcpToolExecute({
      mcpUrl: args.mcpUrl,
      mcpHeaders: args.mcpHeaders,
      mcpToolName: args.mcpTool.name,
      presetParameters: args.presetParameters,
      toolContext: args.toolContext,
      presetSchema: args.mcpTool.inputSchema,
      logToolCallingError: args.logToolCallingError,
    }),
  });
};

type McpToolListing = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/**
 * The `tools/list` half of MCP resolution: everything that can fail before
 * there is a surface to build. `null` is "no listing" — unreachable, refused,
 * or a non-OK answer — which the caller reports; an empty array is a server
 * that really exposes nothing, which is not a failure.
 */
const fetchMcpToolListing = async (args: {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
  logToolCallingError: LogToolCallingError;
  reportResolutionFailure?: (args: { reason: string }) => void;
}): Promise<McpToolListing[] | null> => {
  try {
    const listResponse = await fetchWithEgressGuard(args.mcpUrl, {
      method: 'POST',
      headers: args.mcpHeaders,
      signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    if (!listResponse.ok) {
      args.reportResolutionFailure?.({
        reason: `tools/list answered ${listResponse.status}`,
      });
      return null;
    }

    const listBody = (await listResponse.json()) as {
      result?: { tools?: McpToolListing[] };
    };
    return listBody.result?.tools ?? [];
  } catch (error) {
    args.logToolCallingError({
      toolName: args.mcpUrl,
      toolType: 'mcp',
      url: args.mcpUrl,
      method: 'POST',
      error,
    });
    args.reportResolutionFailure?.({
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
   * Called when the listing could not be obtained. Reporting, not control: an
   * unreachable server still yields an empty surface rather than failing the
   * turn, but a turn that ran without its tools must not be indistinguishable
   * from one that had none to begin with.
   */
  reportResolutionFailure?: (args: { reason: string }) => void;
}): Promise<Record<string, Tool>> => {
  const result: Record<string, Tool> = {};
  const allowedActions =
    args.typedTool.actions != null ? new Set(args.typedTool.actions) : null;
  const deniedActions =
    args.typedTool.deniedActions != null
      ? new Set(args.typedTool.deniedActions)
      : null;
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
    if (allowedActions && !allowedActions.has(mcpTool.name)) continue;
    if (deniedActions && deniedActions.has(mcpTool.name)) continue;
    result[mcpTool.name] = buildMcpToolEntry({
      mcpTool,
      mcpUrl,
      mcpHeaders,
      presetParameters: args.typedTool.presetParameters,
      toolContext: args.toolContext,
      logToolCallingError: args.logToolCallingError,
    });
  }

  return result;
};
