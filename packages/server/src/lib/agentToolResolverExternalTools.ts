import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

import { buildSoatRequestBody } from './agentToolResolverSoatBody';
import { HttpToolError } from './httpToolError';
import { dispatchApiRequestOrThrow, withCallTimeout } from './inProcessApi';
import { soatTools } from './soatTools';
import { buildSoatActionTarget } from './soatToolsHelpers';
import { fetchWithEgressGuard } from './toolEgress';
import {
  mergePresetParameters,
  stripPresetKeysFromSchema,
} from './toolPresetParameters';
import { resolvePresetParametersForCall } from './toolTemplates';

const SOAT_TOOL_CALL_TIMEOUT_MS = process.env.SOAT_TOOL_CALL_TIMEOUT_MS
  ? parseInt(process.env.SOAT_TOOL_CALL_TIMEOUT_MS, 10)
  : 300_000;

const log = createDebug('soat:tools');

type LogToolCallingError = (args: {
  toolName: string;
  toolType: 'http' | 'mcp' | 'builtin' | 'client';
  url?: string;
  method?: string;
  error: unknown;
}) => void;

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

  try {
    const listResponse = await fetchWithEgressGuard(mcpUrl, {
      method: 'POST',
      headers: mcpHeaders,
      signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    if (!listResponse.ok) return result;

    const listBody = (await listResponse.json()) as {
      result?: {
        tools?: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      };
    };

    const listedTools = (listBody.result?.tools ?? []).filter((mcpTool) => {
      if (allowedActions && !allowedActions.has(mcpTool.name)) return false;
      if (deniedActions && deniedActions.has(mcpTool.name)) return false;
      return true;
    });

    for (const mcpTool of listedTools) {
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
  } catch (error) {
    args.logToolCallingError({
      toolName: args.typedTool.mcp.url,
      toolType: 'mcp',
      url: mcpUrl,
      method: 'POST',
      error,
    });
    return result;
  }
};

/**
 * Invokes a SOAT platform action on behalf of a `soat` tool.
 *
 * The action is served **in this process** (`dispatchApiRequest`), not fetched
 * from `http://localhost:$PORT` (#888). Everything the loopback was there to
 * reuse — the route's permission check, strict-field validation, the audit
 * record, request metering, the snake_case response contract — still runs,
 * because the dispatch runs the app's real middleware chain; what is gone is the
 * socket, the JSON round trip, and the requirement that the process be listening
 * on a port at all.
 *
 * `authHeader` therefore keeps its exact former meaning: the credential the
 * action is performed with. A call without one is unauthenticated and is refused
 * by the same middleware that refused it over the wire — sharing a process never
 * implies sharing authority.
 */
export const executeSoatTool = async (args: {
  toolName: string;
  def: (typeof soatTools)[number];
  rawArgs: Record<string, unknown>;
  authHeader?: string;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  logToolCallingError: LogToolCallingError;
}) => {
  // Path *and* query string: `def.path(...)` alone substitutes path parameters
  // only, discarding every `in: query` parameter the action advertises (#924).
  const path = buildSoatActionTarget({ def: args.def, args: args.rawArgs });
  const body = buildSoatRequestBody({
    def: args.def,
    rawArgs: args.rawArgs,
    toolContext: args.toolContext,
    contextKeys: args.contextKeys,
    traceId: args.traceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
  });
  const toolId = `${args.toolName}_${args.def.name}`;
  try {
    log('soat tool execute: %s %s %s', toolId, args.def.method, path);
    // The non-2xx rule is `dispatchApiRequestOrThrow`'s, shared with the MCP
    // surface; only the error type is this caller's — `HttpToolError` carries
    // the status that `isRetriableError` reads to keep a 4xx from being retried.
    return await withCallTimeout({
      promise: dispatchApiRequestOrThrow({
        method: args.def.method,
        path,
        headers: {
          ...(args.authHeader ? { Authorization: args.authHeader } : {}),
          ...args.buildContextHeaders({
            toolContext: args.toolContext,
            contextKeys: args.contextKeys,
          }),
        },
        body,
        wrapError: (response) => {
          log('soat tool result: %s status=%d', toolId, response.status);
          return new HttpToolError(
            `SOAT action '${args.def.name}' failed`,
            response.status,
            JSON.stringify(response.body) ?? '',
            path,
            args.def.method
          );
        },
      }),
      ms: SOAT_TOOL_CALL_TIMEOUT_MS,
      label: `SOAT action '${args.def.name}'`,
    });
  } catch (error) {
    log('soat tool error: %s', toolId);
    args.logToolCallingError({
      toolName: toolId,
      toolType: 'builtin',
      url: path,
      method: args.def.method,
      error,
    });
    throw error;
  }
};

const buildSoatActionTool = (args: {
  toolName: string;
  toolDescription: string | null;
  def: (typeof soatTools)[number];
  presetParameters?: Record<string, unknown>;
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  isSoatActionAllowedByBoundary: (args: {
    boundaryPolicy: unknown;
    iamAction: string;
  }) => boolean;
  logToolCallingError: LogToolCallingError;
}): Tool => {
  const effectiveInputSchema = stripPresetKeysFromSchema(
    args.def.inputSchema as JSONSchema7,
    args.presetParameters
  );
  return tool({
    description: args.toolDescription ?? args.def.description,
    inputSchema: jsonSchema(effectiveInputSchema),
    execute: async (toolArgs: unknown) => {
      const iamAction = args.def.iamAction ?? args.def.name;
      if (
        !args.isSoatActionAllowedByBoundary({
          boundaryPolicy: args.boundaryPolicy,
          iamAction,
        })
      ) {
        return { error: `Forbidden: boundary policy denies ${iamAction}` };
      }
      const rawArgs = mergePresetParameters({
        presetParameters: resolvePresetParametersForCall({
          presetParameters: args.presetParameters,
          toolContext: args.toolContext,
          toolName: args.toolName,
          schema: args.def.inputSchema,
        }),
        input: toolArgs,
      });
      return executeSoatTool({
        toolName: args.toolName,
        def: args.def,
        rawArgs,
        authHeader: args.authHeader,
        toolContext: args.toolContext,
        contextKeys: args.contextKeys,
        traceId: args.traceId,
        rootTraceId: args.rootTraceId,
        remainingDepth: args.remainingDepth,
        buildContextHeaders: args.buildContextHeaders,
        logToolCallingError: args.logToolCallingError,
      });
    },
  });
};

export const resolveSoatTools = (args: {
  typedTool: {
    name: string;
    description: string | null;
    actions: string[] | null;
    presetParameters?: Record<string, unknown> | null;
    contextKeys?: string[] | null;
  };
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  isSoatActionAllowedByBoundary: (args: {
    boundaryPolicy: unknown;
    iamAction: string;
  }) => boolean;
  logToolCallingError: LogToolCallingError;
}): Record<string, Tool> => {
  const result: Record<string, Tool> = {};
  for (const action of args.typedTool.actions ?? []) {
    const def = soatTools.find((t) => {
      return t.name === action;
    });
    if (!def) continue;
    const resolvedToolName = `${args.typedTool.name}_${action}`;
    result[resolvedToolName] = buildSoatActionTool({
      toolName: args.typedTool.name,
      toolDescription: args.typedTool.description,
      def,
      presetParameters: args.typedTool.presetParameters ?? undefined,
      boundaryPolicy: args.boundaryPolicy,
      authHeader: args.authHeader,
      toolContext: args.toolContext,
      contextKeys: args.typedTool.contextKeys,
      traceId: args.traceId,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
      remainingDepth: args.remainingDepth,
      buildContextHeaders: args.buildContextHeaders,
      isSoatActionAllowedByBoundary: args.isSoatActionAllowedByBoundary,
      logToolCallingError: args.logToolCallingError,
    });
  }
  return result;
};
