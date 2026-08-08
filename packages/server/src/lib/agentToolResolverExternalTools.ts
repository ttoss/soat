import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

import { HttpToolError } from './httpToolError';
import { dispatchApiRequest, withCallTimeout } from './inProcessApi';
import { soatTools } from './soatTools';

const SOAT_TOOL_CALL_TIMEOUT_MS = process.env.SOAT_TOOL_CALL_TIMEOUT_MS
  ? parseInt(process.env.SOAT_TOOL_CALL_TIMEOUT_MS, 10)
  : 300_000;

const log = createDebug('soat:tools');

type LogToolCallingError = (args: {
  toolName: string;
  toolType: 'http' | 'mcp' | 'soat' | 'client';
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
  };
  toolContext?: Record<string, string>;
  buildContextHeaders: (
    toolContext?: Record<string, string>
  ) => Record<string, string>;
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
    ...args.buildContextHeaders(args.toolContext),
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

const withToolContext = (args: {
  body: Record<string, unknown>;
  toolContext?: Record<string, string>;
  acceptedBodyFields: string[];
}) => {
  if (!args.toolContext || !args.acceptedBodyFields.includes('tool_context')) {
    return args.body;
  }
  return { ...args.body, tool_context: args.toolContext };
};

const withTraceIds = (args: {
  body: Record<string, unknown>;
  traceId?: string;
  rootTraceId?: string | null;
  acceptedBodyFields: string[];
}) => {
  const acceptsTrace =
    args.acceptedBodyFields.includes('parent_trace_id') &&
    args.acceptedBodyFields.includes('root_trace_id');
  if (!args.traceId || !acceptsTrace) return args.body;
  return {
    ...args.body,
    parent_trace_id: args.traceId,
    root_trace_id: args.rootTraceId ?? args.traceId,
  };
};

const withMaxCallDepth = (args: {
  body: Record<string, unknown>;
  remainingDepth?: number;
  acceptedBodyFields: string[];
}) => {
  if (
    args.remainingDepth === undefined ||
    !args.acceptedBodyFields.includes('max_call_depth')
  ) {
    return args.body;
  }
  return {
    ...args.body,
    max_call_depth: Math.max(0, args.remainingDepth - 1),
  };
};

/**
 * Assembles the request body a SOAT action is called with: the operation's own
 * body, plus the ambient fields the action's schema declares it accepts —
 * `tool_context`, the trace lineage, and the remaining call depth. Exported for
 * direct testing: which fields get injected into which action is a per-action
 * rule with a large input space (#371), and the schema check that enforces it is
 * invisible from the outside once the body has been sent.
 */
export const buildSoatRequestBody = (args: {
  def: (typeof soatTools)[number];
  rawArgs: Record<string, unknown>;
  toolContext?: Record<string, string>;
  traceId?: string;
  rootTraceId?: string | null;
  remainingDepth?: number;
}) => {
  const soatBody = args.def.body ? args.def.body(args.rawArgs) : undefined;
  if (!soatBody) return soatBody;

  const acceptedBodyFields = args.def.acceptedBodyFields;
  const withContext = withToolContext({
    body: soatBody,
    toolContext: args.toolContext,
    acceptedBodyFields,
  });
  const withTrace = withTraceIds({
    body: withContext,
    traceId: args.traceId,
    rootTraceId: args.rootTraceId,
    acceptedBodyFields,
  });
  return withMaxCallDepth({
    body: withTrace,
    remainingDepth: args.remainingDepth,
    acceptedBodyFields,
  });
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
  traceId?: string;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (
    toolContext?: Record<string, string>
  ) => Record<string, string>;
  logToolCallingError: LogToolCallingError;
}) => {
  const path = args.def.path(args.rawArgs);
  const body = buildSoatRequestBody({
    def: args.def,
    rawArgs: args.rawArgs,
    toolContext: args.toolContext,
    traceId: args.traceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
  });
  const toolId = `${args.toolName}_${args.def.name}`;
  try {
    log('soat tool execute: %s %s %s', toolId, args.def.method, path);
    const response = await withCallTimeout({
      promise: dispatchApiRequest({
        method: args.def.method,
        path,
        headers: {
          ...(args.authHeader ? { Authorization: args.authHeader } : {}),
          ...args.buildContextHeaders(args.toolContext),
        },
        body,
      }),
      ms: SOAT_TOOL_CALL_TIMEOUT_MS,
      label: `SOAT action '${args.def.name}'`,
    });
    log('soat tool result: %s status=%d', toolId, response.status);
    // A non-2xx self-call is a failed tool call, not a result. Returning the
    // error body here used to make an unauthorized or rejected platform action
    // indistinguishable from data: an orchestration tool node stored the error
    // object as its artifact and the run carried on as though the action had
    // happened (#801-shaped, but on the call path).
    if (response.status < 200 || response.status >= 300) {
      throw new HttpToolError(
        `SOAT action '${args.def.name}' failed`,
        response.status,
        JSON.stringify(response.body) ?? '',
        path,
        args.def.method
      );
    }
    return response.body;
  } catch (error) {
    log('soat tool error: %s', toolId);
    args.logToolCallingError({
      toolName: toolId,
      toolType: 'soat',
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
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (
    toolContext?: Record<string, string>
  ) => Record<string, string>;
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
  };
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (
    toolContext?: Record<string, string>
  ) => Record<string, string>;
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
