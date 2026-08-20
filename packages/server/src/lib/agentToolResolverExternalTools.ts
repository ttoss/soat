import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

import { buildSoatRequestBody } from './agentToolResolverSoatBody';
import { HttpToolError } from './httpToolError';
import { dispatchApiRequestOrThrow, withCallTimeout } from './inProcessApi';
import { soatTools } from './soatTools';
import { buildSoatActionTarget } from './soatToolsHelpers';

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
  logToolCallingError: LogToolCallingError;
}) => {
  return async (toolArgs: unknown) => {
    try {
      const callResponse = await fetch(args.mcpUrl, {
        method: 'POST',
        headers: args.mcpHeaders,
        signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: args.mcpToolName, arguments: toolArgs },
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

export const resolveMcpTools = async (args: {
  typedTool: {
    mcp: { url: string; headers?: Record<string, string> };
    // Optional allowlist of MCP tool names to expose. `null`/`undefined`
    // exposes the entire MCP server surface (default); a set restricts the
    // model to just those tools — the capability-level primitive that makes a
    // read-only scope over a read+write MCP server enforceable, not just a
    // prompt-level suggestion.
    actions?: string[] | null;
    // Optional denylist of MCP tool names to hide. Applied after the allowlist,
    // and takes precedence over it: a name in both lists is denied. This is the
    // ergonomic way to scope a read+write server read-only — deny just the write
    // tools instead of enumerating every read tool in the allowlist.
    deniedActions?: string[] | null;
    // Per-tool allowlist of `tool_context` keys that may be forwarded as
    // prefixed context headers. `null`/`undefined` forwards all (#945).
    contextKeys?: string[] | null;
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
    const listResponse = await fetch(mcpUrl, {
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
      const mcpToolName = mcpTool.name;
      result[mcpToolName] = tool({
        description: mcpTool.description ?? undefined,
        inputSchema: jsonSchema(
          mcpTool.inputSchema ?? { type: 'object', properties: {} }
        ),
        execute: buildMcpToolExecute({
          mcpUrl,
          mcpHeaders,
          mcpToolName,
          logToolCallingError: args.logToolCallingError,
        }),
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

const buildInputSchemaWithoutPresets = (
  schema: JSONSchema7,
  presetParameters?: Record<string, unknown>
): JSONSchema7 => {
  if (!presetParameters || Object.keys(presetParameters).length === 0) {
    return schema;
  }
  const presetKeys = new Set(Object.keys(presetParameters));
  const props = schema.properties
    ? Object.fromEntries(
        Object.entries(schema.properties).filter(([k]) => {
          return !presetKeys.has(k);
        })
      )
    : {};
  const required = (schema.required ?? []).filter((k) => {
    return !presetKeys.has(k);
  });
  return {
    ...schema,
    properties: props,
    ...(required.length > 0 ? { required } : { required: undefined }),
  };
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
  // Path *and* query string. This used to be `def.path(...)` alone, which
  // substitutes path parameters only — so every `in: query` parameter the
  // action advertises was discarded (#924): a `list-*` call returned everything
  // the credential could see no matter what was asked for, and a
  // `preset_parameters` value targeting a query parameter did nothing at all.
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
  const effectiveInputSchema = buildInputSchemaWithoutPresets(
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
      const rawArgs = {
        ...(args.presetParameters ?? {}),
        ...(toolArgs as Record<string, unknown>),
      };
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
