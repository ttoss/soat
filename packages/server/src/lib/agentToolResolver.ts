import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import {
  evaluatePolicies,
  type PolicyDocument,
  validatePolicyDocument,
} from 'src/lib/iam';

import { db } from '../db';
import { soatTools } from './soatTools';

// ── Path Parameter Interpolation ─────────────────────────────────────────

/**
 * Resolves `{paramName}` placeholders in a URL template using values from
 * toolArgs. Returns the resolved URL and the remaining args (those not consumed
 * as path parameters) to be used for query-string or body serialization.
 *
 * Placeholders that have no matching key in toolArgs are left as-is.
 */
export const resolveUrlPathParams = (args: {
  url: string;
  toolArgs: Record<string, unknown>;
}): { resolvedUrl: string; remainingArgs: Record<string, unknown> } => {
  const pathParamPattern = /\{(\w+)\}/g;
  const pathParams = new Set(
    [...args.url.matchAll(pathParamPattern)].map((m) => {
      return m[1];
    })
  );

  let resolvedUrl = args.url;
  const remainingArgs: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(args.toolArgs)) {
    if (pathParams.has(k)) {
      resolvedUrl = resolvedUrl.replaceAll(
        `{${k}}`,
        encodeURIComponent(String(v))
      );
    } else {
      remainingArgs[k] = v;
    }
  }

  return { resolvedUrl, remainingArgs };
};

// ── Context Headers ───────────────────────────────────────────────────────

export const buildContextHeaders = (
  toolContext?: Record<string, string>
): Record<string, string> => {
  if (!toolContext) return {};
  return Object.fromEntries(
    Object.entries(toolContext).map(([key, value]) => {
      const titleCased = key.charAt(0).toUpperCase() + key.slice(1);
      return [`X-Soat-Context-${titleCased}`, value];
    })
  );
};

// ── IAM Boundary Check ────────────────────────────────────────────────────

export const isSoatActionAllowedByBoundary = (args: {
  boundaryPolicy: unknown;
  iamAction: string;
}): boolean => {
  if (!args.boundaryPolicy) {
    return true;
  }

  const validation = validatePolicyDocument(args.boundaryPolicy);
  if (!validation.valid) {
    return false;
  }

  return evaluatePolicies({
    policies: [args.boundaryPolicy as PolicyDocument],
    action: args.iamAction,
    resource: '*',
  });
};

// ── Per-type Tool Builders ────────────────────────────────────────────────

type TypedHttpTool = {
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
  execute: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
  } | null;
};

const buildHttpRequestUrl = (args: {
  resolvedUrl: string;
  method: string;
  remainingArgs: Record<string, unknown>;
  hasBody: boolean;
}): string => {
  if (args.hasBody || Object.keys(args.remainingArgs).length === 0) {
    return args.resolvedUrl;
  }
  const params = new URLSearchParams(
    Object.entries(args.remainingArgs)
      .filter(([, v]) => {
        return v !== undefined && v !== null;
      })
      .map(([k, v]) => {
        return [k, typeof v === 'object' ? JSON.stringify(v) : String(v)];
      })
  );
  const qs = params.toString();
  const sep = args.resolvedUrl.includes('?') ? '&' : '?';
  return qs ? `${args.resolvedUrl}${sep}${qs}` : args.resolvedUrl;
};

const buildHttpToolExecute = (
  typedTool: TypedHttpTool,
  toolContext?: Record<string, string>
) => {
  return async (toolArgs: unknown) => {
    const ALLOWED_METHODS = [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ];
    const rawMethod = (typedTool.execute!.method ?? 'POST').toUpperCase();
    const method = ALLOWED_METHODS.includes(rawMethod) ? rawMethod : 'POST';
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(method);
    const rawArgs =
      toolArgs && typeof toolArgs === 'object'
        ? (toolArgs as Record<string, unknown>)
        : {};
    const { resolvedUrl, remainingArgs } = resolveUrlPathParams({
      url: typedTool.execute!.url,
      toolArgs: rawArgs,
    });
    const url = buildHttpRequestUrl({
      resolvedUrl,
      method,
      remainingArgs,
      hasBody,
    });
    const response = await fetch(url, {
      method,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...typedTool.execute?.headers,
        ...buildContextHeaders(toolContext),
      },
      ...(hasBody ? { body: JSON.stringify(remainingArgs) } : {}),
    });
    return response.json();
  };
};

const resolveHttpTool = (
  typedTool: TypedHttpTool,
  toolContext?: Record<string, string>
): Tool => {
  const parameters =
    typeof typedTool.parameters === 'string'
      ? (JSON.parse(typedTool.parameters) as Record<string, unknown>)
      : typedTool.parameters;
  return tool({
    description: typedTool.description ?? undefined,
    inputSchema: jsonSchema(parameters ?? { type: 'object', properties: {} }),
    execute: buildHttpToolExecute(typedTool, toolContext),
  });
};

const resolveClientTool = (typedTool: {
  description: string | null;
  parameters: Record<string, unknown> | null;
}): Tool => {
  const parameters =
    typeof typedTool.parameters === 'string'
      ? (JSON.parse(typedTool.parameters) as Record<string, unknown>)
      : typedTool.parameters;
  return tool({
    description: typedTool.description ?? undefined,
    inputSchema: jsonSchema(parameters ?? { type: 'object', properties: {} }),
  });
};

const buildMcpToolExecute = (
  mcpUrl: string,
  mcpHeaders: Record<string, string>,
  mcpToolName: string
) => {
  return async (toolArgs: unknown) => {
    const callResponse = await fetch(mcpUrl, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: mcpToolName, arguments: toolArgs },
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
  };
};

const resolveMcpTools = async (
  typedTool: { mcp: { url: string; headers?: Record<string, string> } },
  toolContext?: Record<string, string>
): Promise<Record<string, Tool>> => {
  const result: Record<string, Tool> = {};
  const mcpUrl = typedTool.mcp.url;
  const mcpHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...typedTool.mcp.headers,
    ...buildContextHeaders(toolContext),
  };

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
      execute: buildMcpToolExecute(mcpUrl, mcpHeaders, mcpToolName),
    });
  }

  return result;
};

const buildSoatActionTool = (args: {
  toolName: string;
  toolDescription: string | null;
  def: (typeof soatTools)[number];
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
}): Tool => {
  const base = `http://localhost:${process.env.PORT || 5047}/api/v1`;
  return tool({
    description: args.toolDescription ?? args.def.description,
    inputSchema: jsonSchema(args.def.inputSchema as JSONSchema7),
    execute: async (toolArgs: unknown) => {
      const iamAction = args.def.iamAction ?? args.def.name;
      if (
        !isSoatActionAllowedByBoundary({
          boundaryPolicy: args.boundaryPolicy,
          iamAction,
        })
      ) {
        return { error: `Forbidden: boundary policy denies ${iamAction}` };
      }
      const rawArgs = toolArgs as Record<string, unknown>;
      const path = args.def.path(rawArgs);
      const soatBody = args.def.body ? args.def.body(rawArgs) : undefined;
      const soatBodyWithContext =
        soatBody && args.toolContext
          ? { ...soatBody, toolContext: args.toolContext }
          : soatBody;
      const response = await fetch(`${base}${path}`, {
        method: args.def.method,
        headers: {
          'Content-Type': 'application/json',
          ...(args.authHeader ? { Authorization: args.authHeader } : {}),
          ...buildContextHeaders(args.toolContext),
        },
        body: soatBodyWithContext
          ? JSON.stringify(soatBodyWithContext)
          : undefined,
      });
      return response.json();
    },
  });
};

const resolveSoatTools = (
  typedTool: {
    name: string;
    description: string | null;
    actions: string[] | null;
  },
  args: {
    boundaryPolicy?: unknown;
    authHeader?: string;
    toolContext?: Record<string, string>;
  }
): Record<string, Tool> => {
  const result: Record<string, Tool> = {};
  for (const action of typedTool.actions ?? []) {
    const def = soatTools.find((t) => {
      return t.name === action;
    });
    if (!def) continue;
    const resolvedToolName = `${typedTool.name}_${action}`;
    result[resolvedToolName] = buildSoatActionTool({
      toolName: typedTool.name,
      toolDescription: typedTool.description,
      def,
      boundaryPolicy: args.boundaryPolicy,
      authHeader: args.authHeader,
      toolContext: args.toolContext,
    });
  }
  return result;
};

// ── Tool Resolution ───────────────────────────────────────────────────────

type AgentToolRow = {
  type: string;
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
  execute: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
  } | null;
  mcp: { url: string; headers?: Record<string, string> } | null;
  actions: string[] | null;
};

const resolveToolByType = async (
  typedTool: AgentToolRow,
  args: {
    boundaryPolicy?: unknown;
    authHeader?: string;
    toolContext?: Record<string, string>;
  }
): Promise<Record<string, Tool>> => {
  switch (typedTool.type) {
    case 'http':
      return { [typedTool.name]: resolveHttpTool(typedTool, args.toolContext) };
    case 'client':
      return { [typedTool.name]: resolveClientTool(typedTool) };
    case 'mcp': {
      if (!typedTool.mcp?.url) return {};
      try {
        return await resolveMcpTools(
          typedTool as {
            mcp: { url: string; headers?: Record<string, string> };
          },
          args.toolContext
        );
      } catch {
        // Network errors resolving MCP tools should not abort entire resolution
        return {};
      }
    }
    case 'soat':
      return resolveSoatTools(typedTool, args);
    default:
      return {};
  }
};

export const resolveAgentTools = async (args: {
  toolIds: string[];
  projectIds?: number[];
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
}): Promise<Record<string, Tool>> => {
  const resolvedTools: Record<string, Tool> = {};

  for (const toolPublicId of args.toolIds) {
    const toolWhere: Record<string, unknown> = { publicId: toolPublicId };
    if (args.projectIds !== undefined) {
      toolWhere.projectId = args.projectIds;
    }

    const agentTool = await db.AgentTool.findOne({ where: toolWhere });
    if (!agentTool) continue;

    const typedTool = agentTool as unknown as AgentToolRow;
    Object.assign(resolvedTools, await resolveToolByType(typedTool, args));
  }

  return resolvedTools;
};
