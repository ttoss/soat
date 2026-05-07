import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

import { soatTools } from './soatTools';

const log = createDebug('soat:tools');

type LogToolCallingError = (args: {
  toolName: string;
  toolType: 'http' | 'mcp' | 'soat' | 'client';
  url?: string;
  method?: string;
  error: unknown;
}) => void;

const buildMcpToolExecute = (args: {
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

const buildSoatActionTool = (args: {
  toolName: string;
  toolDescription: string | null;
  def: (typeof soatTools)[number];
  presetParameters?: Record<string, unknown>;
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
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
      const path = args.def.path(rawArgs);
      const soatBody = args.def.body ? args.def.body(rawArgs) : undefined;
      const soatBodyWithContext =
        soatBody && args.toolContext
          ? { ...soatBody, toolContext: args.toolContext }
          : soatBody;

      try {
        const url = `${base}${path}`;
        const toolId = `${args.toolName}_${args.def.name}`;
        log('soat tool execute: %s %s %s', toolId, args.def.method, url);
        const response = await fetch(url, {
          method: args.def.method,
          headers: {
            'Content-Type': 'application/json',
            ...(args.authHeader ? { Authorization: args.authHeader } : {}),
            ...args.buildContextHeaders(args.toolContext),
          },
          body: soatBodyWithContext
            ? JSON.stringify(soatBodyWithContext)
            : undefined,
        });
        const responseBody = await response.json();
        log('soat tool result: %s status=%d', toolId, response.status);
        return responseBody;
      } catch (error) {
        log('soat tool error: %s', `${args.toolName}_${args.def.name}`);
        args.logToolCallingError({
          toolName: `${args.toolName}_${args.def.name}`,
          toolType: 'soat',
          url: `${base}${path}`,
          method: args.def.method,
          error,
        });
        throw error;
      }
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
      buildContextHeaders: args.buildContextHeaders,
      isSoatActionAllowedByBoundary: args.isSoatActionAllowedByBoundary,
      logToolCallingError: args.logToolCallingError,
    });
  }
  return result;
};
