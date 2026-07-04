import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

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
  typedTool: { mcp: { url: string; headers?: Record<string, string> } };
  toolContext?: Record<string, string>;
  buildContextHeaders: (
    toolContext?: Record<string, string>
  ) => Record<string, string>;
  logToolCallingError: LogToolCallingError;
}): Promise<Record<string, Tool>> => {
  const result: Record<string, Tool> = {};
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

    for (const mcpTool of listBody.result?.tools ?? []) {
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

const buildSoatRequestBody = (args: {
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

export const executeSoatTool = async (args: {
  toolName: string;
  def: (typeof soatTools)[number];
  rawArgs: Record<string, unknown>;
  base: string;
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
  try {
    const url = `${args.base}${path}`;
    const toolId = `${args.toolName}_${args.def.name}`;
    log('soat tool execute: %s %s %s', toolId, args.def.method, url);
    const response = await fetch(url, {
      method: args.def.method,
      headers: {
        'Content-Type': 'application/json',
        ...(args.authHeader ? { Authorization: args.authHeader } : {}),
        ...args.buildContextHeaders(args.toolContext),
      },
      signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseBody = await response.json();
    log('soat tool result: %s status=%d', toolId, response.status);
    return responseBody;
  } catch (error) {
    log('soat tool error: %s', `${args.toolName}_${args.def.name}`);
    args.logToolCallingError({
      toolName: `${args.toolName}_${args.def.name}`,
      toolType: 'soat',
      url: `${args.base}${path}`,
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
  const base = `http://localhost:${process.env.PORT || 5047}`;
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
        base,
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
