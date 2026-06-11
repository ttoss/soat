/* eslint-disable max-lines */
import type { Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';
import {
  evaluatePolicies,
  type PolicyDocument,
  validatePolicyDocument,
} from 'src/lib/iam';

import { db } from '../db';
import {
  resolveMcpTools,
  resolveSoatTools,
} from './agentToolResolverExternalTools';

const log = createDebug('soat:toolResolver');

// ── Path Parameter Interpolation ─────────────────────────────────────────

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

const BODY_PARAM_RE = /\$\{body\.(\w+)\}/g;

// Resolves ${body.fieldName} placeholders from toolArgs at call time.
export const resolveBodyParamInterpolations = (args: {
  url: string;
  toolArgs: Record<string, unknown>;
}): { resolvedUrl: string; remainingArgs: Record<string, unknown> } => {
  const bodyParams = new Set(
    [...args.url.matchAll(BODY_PARAM_RE)].map((m) => {
      return m[1];
    })
  );
  const remainingArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.toolArgs)) {
    if (!bodyParams.has(k)) remainingArgs[k] = v;
  }
  const resolvedUrl = args.url.replace(
    BODY_PARAM_RE,
    (original, field: string) => {
      const value = args.toolArgs[field];
      if (value === undefined) return original;
      return encodeURIComponent(String(value));
    }
  );
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
  execute:
    | {
        url: string;
        method?: string;
        headers?: Record<string, string>;
      }
    | string
    | null;
};

export type HttpExecuteConfig = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
};

const isErrorLoggingEnabled = () => {
  const value = process.env.SOAT_ERROR_LOGS_ENABLED;

  if (value === undefined) {
    return true;
  }

  return !['false', '0', 'off', 'no'].includes(value.toLowerCase());
};

const toToolErrorText = (args: { error: unknown }) => {
  if (args.error instanceof Error) {
    return args.error.stack ?? args.error.message;
  }

  return String(args.error);
};

const logToolCallingError = (args: {
  toolName: string;
  toolType: 'http' | 'mcp' | 'soat' | 'client';
  url?: string;
  method?: string;
  error: unknown;
}) => {
  if (!isErrorLoggingEnabled()) {
    return;
  }

  log(
    'logToolCallError: tool call failed toolName=%s toolType=%s url=%s method=%s error=%s',
    args.toolName,
    args.toolType,
    args.url,
    args.method,
    toToolErrorText({ error: args.error })
  );
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const parseHeaders = (args: {
  value: unknown;
}): Record<string, string> | undefined => {
  if (!isPlainObject(args.value)) {
    return undefined;
  }

  return args.value as Record<string, string>;
};

export const parseHttpExecuteConfig = (
  execute: TypedHttpTool['execute']
): HttpExecuteConfig | null => {
  const parsedExecute: unknown =
    typeof execute === 'string' ? JSON.parse(execute) : execute;

  if (!isPlainObject(parsedExecute)) {
    return null;
  }

  const url = parsedExecute.url;
  if (typeof url !== 'string' || !url) {
    return null;
  }

  const method = parsedExecute.method;

  return {
    url,
    method: typeof method === 'string' ? method : undefined,
    headers: parseHeaders({ value: parsedExecute.headers }),
  };
};

const buildInvalidHttpToolExecute = (args: {
  toolName: string;
  rawExecute: unknown;
}) => {
  return async () => {
    const error = new Error(
      `Invalid HTTP tool execute config for ${args.toolName}: expected object with string url`
    );
    logToolCallingError({
      toolName: args.toolName,
      toolType: 'http',
      error: {
        message: error.message,
        execute: args.rawExecute,
      },
    });
    throw error;
  };
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

export class HttpToolError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'HttpToolError';
    this.status = status;
    this.body = body;
  }

  toJSON() {
    return {
      message: this.message,
      name: this.name,
      status: this.status,
      body: this.body,
    };
  }
}

export const buildHttpToolExecute = (
  args: {
    toolName: string;
    execute: HttpExecuteConfig;
  },
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
    const rawMethod = (args.execute.method ?? 'POST').toUpperCase();
    const method = ALLOWED_METHODS.includes(rawMethod) ? rawMethod : 'POST';
    const hasBody = !['GET', 'HEAD'].includes(method);
    const rawArgs =
      toolArgs && typeof toolArgs === 'object'
        ? (toolArgs as Record<string, unknown>)
        : {};
    let url = args.execute.url;
    try {
      const {
        resolvedUrl: afterPathParams,
        remainingArgs: afterPathParamsArgs,
      } = resolveUrlPathParams({ url: args.execute.url, toolArgs: rawArgs });
      const { resolvedUrl, remainingArgs } = resolveBodyParamInterpolations({
        url: afterPathParams,
        toolArgs: afterPathParamsArgs,
      });
      url = buildHttpRequestUrl({
        resolvedUrl,
        method,
        remainingArgs,
        hasBody,
      });
      const response = await fetch(url, {
        method,
        headers: {
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...args.execute.headers,
          ...buildContextHeaders(toolContext),
        },
        ...(hasBody ? { body: JSON.stringify(remainingArgs) } : {}),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new HttpToolError(
          `HTTP ${response.status}: ${body}`,
          response.status,
          body
        );
      }
      return response.json();
    } catch (error) {
      logToolCallingError({
        toolName: args.toolName,
        toolType: 'http',
        url,
        method,
        error,
      });
      throw error;
    }
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
  let execute: HttpExecuteConfig | null = null;
  try {
    execute = parseHttpExecuteConfig(typedTool.execute);
  } catch {
    execute = null;
  }

  return tool({
    description: typedTool.description ?? undefined,
    inputSchema: jsonSchema(parameters ?? { type: 'object', properties: {} }),
    execute: execute
      ? buildHttpToolExecute({ toolName: typedTool.name, execute }, toolContext)
      : buildInvalidHttpToolExecute({
          toolName: typedTool.name,
          rawExecute: typedTool.execute,
        }),
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

// ── Tool Resolution ───────────────────────────────────────────────────────

type AgentToolRow = {
  type: string;
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
  execute:
    | {
        url: string;
        method?: string;
        headers?: Record<string, string>;
      }
    | string
    | null;
  mcp: { url: string; headers?: Record<string, string> } | null;
  actions: string[] | null;
  presetParameters: Record<string, unknown> | null;
};

const resolveToolByType = async (
  typedTool: AgentToolRow,
  args: {
    boundaryPolicy?: unknown;
    authHeader?: string;
    toolContext?: Record<string, string>;
    traceId?: string;
    parentTraceId?: string | null;
    rootTraceId?: string | null;
    remainingDepth?: number;
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
        return await resolveMcpTools({
          typedTool: typedTool as {
            mcp: { url: string; headers?: Record<string, string> };
          },
          toolContext: args.toolContext,
          buildContextHeaders,
          logToolCallingError,
        });
      } catch {
        // Network errors resolving MCP tools should not abort entire resolution
        return {};
      }
    }
    case 'soat':
      return resolveSoatTools({
        typedTool,
        boundaryPolicy: args.boundaryPolicy,
        authHeader: args.authHeader,
        toolContext: args.toolContext,
        traceId: args.traceId,
        parentTraceId: args.parentTraceId,
        rootTraceId: args.rootTraceId,
        remainingDepth: args.remainingDepth,
        buildContextHeaders,
        isSoatActionAllowedByBoundary,
        logToolCallingError,
      });
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
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
}): Promise<Record<string, Tool>> => {
  const resolvedTools: Record<string, Tool> = {};

  for (const toolPublicId of args.toolIds) {
    const toolWhere: Record<string, unknown> = { publicId: toolPublicId };
    if (args.projectIds !== undefined) {
      toolWhere.projectId = args.projectIds;
    }

    const agentTool = await db.Tool.findOne({ where: toolWhere });
    if (!agentTool) continue;

    const typedTool = agentTool as unknown as AgentToolRow;
    Object.assign(resolvedTools, await resolveToolByType(typedTool, args));
  }

  return resolvedTools;
};
