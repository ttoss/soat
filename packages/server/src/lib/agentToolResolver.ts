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
import { DomainError } from '../errors';
import {
  resolveMcpTools,
  resolveSoatTools,
} from './agentToolResolverExternalTools';
import { applyToolOutputMapping } from './jsonLogicMapping';
import {
  resolveSecretRefsInRecord,
  resolveSecretRefsInString,
} from './secrets';
import type { InlineToolDefinition } from './tools';

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
  projectId: number;
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
  bodyMode?: 'json' | 'multipart';
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

  // `body_mode` (snake_case) arrives verbatim from formation templates, while
  // the REST caseTransform middleware rewrites it to `bodyMode` — accept both.
  const rawBodyMode = parsedExecute.bodyMode ?? parsedExecute.body_mode;

  return {
    url,
    method: typeof method === 'string' ? method : undefined,
    headers: parseHeaders({ value: parsedExecute.headers }),
    bodyMode: rawBodyMode === 'multipart' ? 'multipart' : 'json',
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
  url: string;
  method: string;

  constructor(
    message: string,
    status: number,
    body: string,
    url: string,
    method: string
  ) {
    super(message);
    this.name = 'HttpToolError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.method = method;
  }

  toJSON() {
    return {
      message: this.message,
      name: this.name,
      status: this.status,
      url: this.url,
      method: this.method,
      body: this.body,
    };
  }
}

/**
 * Maps an `HttpToolError` (thrown when an http-type tool's target returns a
 * non-2xx response) to a `TOOL_HTTP_ERROR` `DomainError` (HTTP 502), so the
 * real upstream status/body/url survive to the API response instead of being
 * discarded behind a generic 500. Returns `null` for any other error, so
 * callers can rethrow it unchanged.
 */
export const toHttpToolDomainError = (error: unknown): DomainError | null => {
  if (!(error instanceof HttpToolError)) {
    return null;
  }

  // Error responses bypass the caseTransform middleware, so meta keys are
  // written in snake_case to match the external REST contract.
  return new DomainError(
    'TOOL_HTTP_ERROR',
    `Tool target returned HTTP ${error.status}: ${error.message}`,
    {
      tool_status_code: error.status,
      tool_response_body: error.body,
      tool_url: error.url,
      tool_method: error.method,
    }
  );
};

// Resolves {{secret:...}} tokens in the request url and headers at the point
// of use — the stored config (and anything echoed back by GET/LIST) keeps the
// reference.
const resolveHttpRequestSecrets = async (args: {
  url: string;
  headers?: Record<string, string>;
  projectId: number;
}) => {
  return {
    fetchUrl: await resolveSecretRefsInString({
      value: args.url,
      projectId: args.projectId,
    }),
    headers: await resolveSecretRefsInRecord({
      record: args.headers,
      projectId: args.projectId,
    }),
  };
};

// ── Multipart Body Construction ───────────────────────────────────────────

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
};

// A file-shaped field carries base64 data plus optional filename/content-type
// hints — matching the ingestion converter's `file` input shape.
const extractFilePart = (
  value: unknown
): { base64: string; filename: string; contentType: string } | null => {
  if (!isPlainObject(value)) return null;
  const base64 = firstString(value.data_base64, value.dataBase64);
  if (base64 === undefined) return null;
  return {
    base64,
    filename: firstString(value.filename) ?? 'file',
    contentType:
      firstString(value.content_type, value.contentType) ??
      'application/octet-stream',
  };
};

const appendMultipartField = (
  form: FormData,
  key: string,
  value: unknown
): void => {
  const filePart = extractFilePart(value);
  if (filePart) {
    const buffer = Buffer.from(filePart.base64, 'base64');
    form.append(
      key,
      new Blob([buffer], { type: filePart.contentType }),
      filePart.filename
    );
    return;
  }
  if (value === undefined || value === null) return;
  form.append(
    key,
    typeof value === 'object' ? JSON.stringify(value) : String(value)
  );
};

const buildMultipartBody = (
  remainingArgs: Record<string, unknown>
): FormData => {
  const form = new FormData();
  for (const [key, value] of Object.entries(remainingArgs)) {
    appendMultipartField(form, key, value);
  }
  return form;
};

// A caller-set Content-Type would clobber the multipart boundary `fetch`
// generates, so drop it in multipart mode and let `fetch` set it.
const withoutContentType = (
  headers?: Record<string, string>
): Record<string, string> | undefined => {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => {
      return key.toLowerCase() !== 'content-type';
    })
  );
};

// Builds the fetch RequestInit, selecting JSON or multipart body encoding.
// `resolvedHeaders` are the execute headers after {{secret:...}} resolution.
const buildHttpRequestInit = (args: {
  method: string;
  hasBody: boolean;
  bodyMode?: HttpExecuteConfig['bodyMode'];
  resolvedHeaders?: Record<string, string>;
  remainingArgs: Record<string, unknown>;
  toolContext?: Record<string, string>;
}): RequestInit => {
  const isMultipart = args.hasBody && args.bodyMode === 'multipart';
  const headers: Record<string, string> = {
    ...(args.hasBody && !isMultipart
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(isMultipart
      ? withoutContentType(args.resolvedHeaders)
      : args.resolvedHeaders),
    ...buildContextHeaders(args.toolContext),
  };
  const init: RequestInit = { method: args.method, headers };
  if (args.hasBody) {
    init.body = isMultipart
      ? buildMultipartBody(args.remainingArgs)
      : JSON.stringify(args.remainingArgs);
  }
  return init;
};

export const buildHttpToolExecute = (
  args: {
    toolName: string;
    execute: HttpExecuteConfig;
    projectId: number;
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
      const resolved = await resolveHttpRequestSecrets({
        url,
        headers: args.execute.headers,
        projectId: args.projectId,
      });
      const response = await fetch(
        resolved.fetchUrl,
        buildHttpRequestInit({
          method,
          hasBody,
          bodyMode: args.execute.bodyMode,
          resolvedHeaders: resolved.headers,
          remainingArgs,
          toolContext,
        })
      );
      if (!response.ok) {
        const body = await response.text();
        throw new HttpToolError(
          `HTTP ${response.status} ${method} ${url}: ${body}`,
          response.status,
          body,
          url,
          method
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
      ? buildHttpToolExecute(
          {
            toolName: typedTool.name,
            execute,
            projectId: typedTool.projectId,
          },
          toolContext
        )
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

const resolveDiscussionTool = (typedTool: {
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
  discussion: { discussionId: string } | null;
}): Tool => {
  const discussionId = typedTool.discussion?.discussionId ?? '';
  const parameters =
    typeof typedTool.parameters === 'string'
      ? (JSON.parse(typedTool.parameters) as Record<string, unknown>)
      : typedTool.parameters;
  return tool({
    description: typedTool.description ?? undefined,
    inputSchema: jsonSchema(parameters ?? { type: 'object', properties: {} }),
    execute: async (input: Record<string, unknown>) => {
      const { runDiscussion } = await import('./discussionRuns');
      const run = await runDiscussion({
        discussionId,
        topic: String(input.topic ?? ''),
        initiatorGenerationId:
          typeof input.initiatorGenerationId === 'string'
            ? input.initiatorGenerationId
            : undefined,
      });
      return { outcome: run.outcome, run_id: run.id };
    },
  });
};

const resolveMcpToolEntry = async (
  typedTool: AgentToolRow,
  toolContext?: Record<string, string>
): Promise<Record<string, Tool>> => {
  if (!typedTool.mcp?.url) return {};
  try {
    // Resolve {{secret:...}} tokens right before connecting to the MCP
    // server — the stored config keeps the reference.
    const mcp = {
      url: await resolveSecretRefsInString({
        value: typedTool.mcp.url,
        projectId: typedTool.projectId,
      }),
      headers: await resolveSecretRefsInRecord({
        record: typedTool.mcp.headers,
        projectId: typedTool.projectId,
      }),
    };
    return await resolveMcpTools({
      typedTool: { mcp },
      toolContext,
      buildContextHeaders,
      logToolCallingError,
    });
  } catch {
    // Network errors resolving MCP tools should not abort entire resolution
    return {};
  }
};

// ── Tool Resolution ───────────────────────────────────────────────────────

type AgentToolRow = {
  publicId: string;
  projectId: number;
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
  discussion: { discussionId: string } | null;
  actions: string[] | null;
  presetParameters: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
};

/**
 * Wraps every resolved AI-SDK tool's `execute` with {@link applyToolOutputMapping}
 * so the model receives the reshaped result instead of the tool's raw output.
 * A single wrap point here covers `http`, `mcp`, `soat`, and `pipeline` — the
 * only tool types that produce an `execute` function; `client` tools have none.
 */
const wrapExecuteWithOutputMapping = (
  originalExecute: NonNullable<Tool['execute']>,
  outputMapping: Record<string, unknown>
): NonNullable<Tool['execute']> => {
  return async (...executeArgs) => {
    const rawResult = await originalExecute(...executeArgs);
    return applyToolOutputMapping(outputMapping, rawResult);
  };
};

const wrapToolsWithOutputMapping = (
  tools: Record<string, Tool>,
  outputMapping: Record<string, unknown> | null
): Record<string, Tool> => {
  if (!outputMapping) return tools;
  const wrapped: Record<string, Tool> = {};
  for (const [name, typedTool] of Object.entries(tools)) {
    wrapped[name] = typedTool.execute
      ? {
          ...typedTool,
          execute: wrapExecuteWithOutputMapping(
            typedTool.execute,
            outputMapping
          ),
        }
      : typedTool;
  }
  return wrapped;
};

const resolvePipelineTool = (
  typedTool: AgentToolRow,
  args: {
    projectIds?: number[];
    authHeader?: string;
    remainingDepth?: number;
  }
): Tool => {
  const parameters =
    typeof typedTool.parameters === 'string'
      ? (JSON.parse(typedTool.parameters) as Record<string, unknown>)
      : typedTool.parameters;
  return tool({
    description: typedTool.description ?? undefined,
    inputSchema: jsonSchema(parameters ?? { type: 'object', properties: {} }),
    execute: async (toolArgs: unknown) => {
      const input =
        toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)
          ? (toolArgs as Record<string, unknown>)
          : {};
      // Imported lazily to avoid a static import cycle with tools.ts.
      const { callTool } = await import('./tools');
      return callTool({
        projectIds: args.projectIds,
        id: typedTool.publicId,
        input,
        authHeader: args.authHeader,
        remainingDepth: args.remainingDepth,
      });
    },
  });
};

const resolveToolByType = async (
  typedTool: AgentToolRow,
  args: {
    projectIds?: number[];
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
    case 'pipeline':
      return {
        [typedTool.name]: resolvePipelineTool(typedTool, {
          projectIds: args.projectIds,
          authHeader: args.authHeader,
          remainingDepth: args.remainingDepth,
        }),
      };
    case 'mcp':
      return resolveMcpToolEntry(typedTool, args.toolContext);
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
    case 'discussion':
      if (!typedTool.discussion?.discussionId) return {};
      return { [typedTool.name]: resolveDiscussionTool(typedTool) };
    default:
      return {};
  }
};

/**
 * Resolves an ephemeral (inline, unpersisted) tool definition into an AI-SDK
 * tool — reusing the same `resolveToolByType` dispatch as a persisted Tool
 * row, adapted to a synthetic `AgentToolRow`. `projectId` scopes
 * `{{secret:...}}` resolution for `http`/`mcp` definitions. `pipeline`-type
 * definitions are rejected by `assertEphemeralTypeSupported` (imported
 * dynamically to avoid a circular import with tools.ts, which imports this
 * module) before resolution — they have no persisted steps to resolve.
 */
export const resolveEphemeralAgentTool = async (args: {
  definition: InlineToolDefinition;
  projectId: number;
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
}): Promise<Record<string, Tool>> => {
  const { assertEphemeralTypeSupported } = await import('./tools');
  assertEphemeralTypeSupported(args.definition);

  const typedTool: AgentToolRow = {
    publicId: '',
    projectId: args.projectId,
    type: args.definition.type ?? 'http',
    name: args.definition.name,
    description: args.definition.description ?? null,
    parameters:
      (args.definition.parameters as Record<string, unknown> | undefined) ??
      null,
    execute: (args.definition.execute as AgentToolRow['execute']) ?? null,
    mcp: (args.definition.mcp as AgentToolRow['mcp']) ?? null,
    discussion: args.definition.discussionId
      ? { discussionId: args.definition.discussionId }
      : null,
    actions: args.definition.actions ?? null,
    presetParameters:
      (args.definition.presetParameters as
        Record<string, unknown> | undefined) ?? null,
    outputMapping:
      (args.definition.outputMapping as Record<string, unknown> | undefined) ??
      null,
  };

  const tools = await resolveToolByType(typedTool, args);
  return wrapToolsWithOutputMapping(tools, typedTool.outputMapping);
};

export const resolveAgentTools = async (args: {
  toolIds: string[];
  tools?: InlineToolDefinition[] | null;
  projectId?: number;
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
    const tools = await resolveToolByType(typedTool, args);
    // Pipeline tools delegate execution to `callTool` (tools.ts), which
    // already applies `outputMapping` to its return value — wrapping again
    // here would double-apply the mapping.
    Object.assign(
      resolvedTools,
      typedTool.type === 'pipeline'
        ? tools
        : wrapToolsWithOutputMapping(tools, typedTool.outputMapping)
    );
  }

  if (args.projectId !== undefined) {
    for (const definition of args.tools ?? []) {
      const ephemeralTools = await resolveEphemeralAgentTool({
        definition,
        projectId: args.projectId,
        boundaryPolicy: args.boundaryPolicy,
        authHeader: args.authHeader,
        toolContext: args.toolContext,
        traceId: args.traceId,
        parentTraceId: args.parentTraceId,
        rootTraceId: args.rootTraceId,
        remainingDepth: args.remainingDepth,
      });
      Object.assign(resolvedTools, ephemeralTools);
    }
  }

  return resolvedTools;
};
