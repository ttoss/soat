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
  type ActivityCallContext,
  recordToolActivity,
} from './agentToolActivity';
import {
  gateResolvedToolsWithGuardrails,
  type ResolverGuardrailContext,
} from './agentToolGuardrail';
import {
  resolveMcpTools,
  resolveSoatTools,
} from './agentToolResolverExternalTools';
import { HttpToolError } from './httpToolError';
import { applyToolOutputMapping } from './jsonLogicMapping';
import { isPlainObject } from './plainObject';
import { resolveSecretRefsInString } from './secrets';
import {
  applyHttpToolAuth,
  type HttpToolAuthConfig,
  mergeAuthHeaders,
  parseHttpToolAuthConfig,
} from './toolAuth';
import {
  assertValidToolContextKeys,
  buildContextHeaderName,
  buildContextHeaders,
} from './toolContext';
import {
  assertEphemeralTypeSupported,
  callTool,
  type InlineToolDefinition,
} from './tools';
import { resolveToolHeaderTemplates } from './toolTemplates';
// Re-exported from its own module (both http and soat tool paths throw it).
export { HttpToolError } from './httpToolError';

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

// The mechanism lives in `toolContext.ts` so the session/generation write paths
// can validate caller-supplied keys without importing this module. Re-exported
// here because this is where tool callers reach for it.
export {
  assertValidToolContextKeys,
  buildContextHeaderName,
  buildContextHeaders,
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
  auth?: HttpToolAuthConfig;
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

  // `body_mode` is the wire and template spelling. The `bodyMode` fallback
  // reads rows persisted before single-casing, when the request middleware
  // camelCased nested keys before they were stored.
  const rawBodyMode = parsedExecute.bodyMode ?? parsedExecute.body_mode;

  return {
    url,
    method: typeof method === 'string' ? method : undefined,
    headers: parseHeaders({ value: parsedExecute.headers }),
    bodyMode: rawBodyMode === 'multipart' ? 'multipart' : 'json',
    auth: parseHttpToolAuthConfig(parsedExecute.auth),
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

  // Meta keys are
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

// Credential fields are resolved field by field rather than by walking the
// config: an AWS secret access key or a service account JSON blob is opaque
// text, and nothing here may rewrite what it contains.
const resolveAuthSecrets = async (args: {
  auth?: HttpToolAuthConfig;
  projectId: number;
}): Promise<HttpToolAuthConfig | undefined> => {
  const { auth, projectId } = args;
  if (!auth) return undefined;

  const resolve = (value: string) => {
    return resolveSecretRefsInString({ value, projectId });
  };

  if (auth.type === 'aws_sigv4') {
    return {
      type: 'aws_sigv4',
      region: await resolve(auth.region),
      service: await resolve(auth.service),
      accessKeyId: await resolve(auth.accessKeyId),
      secretAccessKey: await resolve(auth.secretAccessKey),
      sessionToken: auth.sessionToken
        ? await resolve(auth.sessionToken)
        : undefined,
    };
  }

  return {
    type: 'gcp_service_account',
    credentials: await resolve(auth.credentials),
    scopes: auth.scopes,
  };
};

// Resolves template tokens in the request url and headers at the point of use —
// the stored config (and anything echoed back by GET/LIST) keeps the reference.
//
// The url and auth resolve `{{secret:...}}` only; headers additionally resolve
// `{{context:...}}` against this call's `tool_context` (#945). The asymmetry is
// the point: a context value is caller-supplied, so it may not steer the
// outbound url — see `toolTemplates.ts`.
const resolveHttpRequestTemplates = async (args: {
  url: string;
  headers?: Record<string, string>;
  auth?: HttpToolAuthConfig;
  projectId: number;
  toolContext?: Record<string, string>;
}) => {
  return {
    fetchUrl: await resolveSecretRefsInString({
      value: args.url,
      projectId: args.projectId,
    }),
    headers: await resolveToolHeaderTemplates({
      record: args.headers,
      projectId: args.projectId,
      toolContext: args.toolContext,
    }),
    auth: await resolveAuthSecrets({
      auth: args.auth,
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
  // Verbatim headers merged last (e.g. `Idempotency-Key`), not context-prefixed.
  extraHeaders?: Record<string, string>;
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
    ...(args.extraHeaders ?? {}),
  };
  const init: RequestInit = { method: args.method, headers };
  if (args.hasBody) {
    init.body = isMultipart
      ? buildMultipartBody(args.remainingArgs)
      : JSON.stringify(args.remainingArgs);
  }
  return init;
};

/**
 * Adds the `execute.auth` credential headers to an already-built request init.
 * A no-op when the tool declares no auth, so the unauthenticated http path is
 * byte-for-byte unchanged.
 */
const withHttpToolAuth = async (args: {
  auth?: HttpToolAuthConfig;
  method: string;
  url: string;
  init: RequestInit;
}): Promise<RequestInit> => {
  if (!args.auth) return args.init;

  const headers = (args.init.headers ?? {}) as Record<string, string>;
  const body = args.init.body;

  // `body` is a string in json mode and a `FormData` in multipart mode. Only
  // the former is hashable at signing time, which is why `validateExecuteAuth`
  // rejects aws_sigv4 + multipart at every write path — so a non-string body
  // can only pair with `gcp_service_account`, which does not sign the payload.
  const authHeaders = await applyHttpToolAuth({
    auth: args.auth,
    method: args.method,
    url: args.url,
    headers,
    body: typeof body === 'string' ? body : undefined,
  });

  return {
    ...args.init,
    headers: mergeAuthHeaders({ headers, authHeaders }),
  };
};

/**
 * Turns the target's response into the tool result, mapping a non-2xx status to
 * an `HttpToolError` (which the caller maps to `502 TOOL_HTTP_ERROR`).
 */
const readHttpToolResponse = async (args: {
  response: Response;
  method: string;
  url: string;
}): Promise<unknown> => {
  const { response, method, url } = args;

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

  // The target may return a 2xx with a non-JSON body (HTML, plain text, an
  // empty 204) — fall back to the raw text instead of letting `SyntaxError`
  // from a strict `response.json()` escape as an unmapped (and thus opaque
  // 500) error.
  const responseText = await response.text();
  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
};

const ALLOWED_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

export const buildHttpToolExecute = (
  args: {
    toolName: string;
    execute: HttpExecuteConfig;
    projectId: number;
    // Verbatim request headers (e.g. `Idempotency-Key`) merged last, after
    // execute headers and context headers.
    extraHeaders?: Record<string, string>;
  },
  toolContext?: Record<string, string>
) => {
  return async (toolArgs: unknown) => {
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
      const resolved = await resolveHttpRequestTemplates({
        url,
        headers: args.execute.headers,
        auth: args.execute.auth,
        projectId: args.projectId,
        toolContext,
      });
      const init = buildHttpRequestInit({
        method,
        hasBody,
        bodyMode: args.execute.bodyMode,
        resolvedHeaders: resolved.headers,
        remainingArgs,
        toolContext,
        extraHeaders: args.extraHeaders,
      });
      // Credentials are computed last, over the final method, url, headers and
      // body — SigV4 signs a hash of exactly what goes on the wire, so nothing
      // may be added to the request after this point.
      const response = await fetch(
        resolved.fetchUrl,
        await withHttpToolAuth({
          auth: resolved.auth,
          method,
          url: resolved.fetchUrl,
          init,
        })
      );
      return await readHttpToolResponse({ response, method, url });
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
      headers: await resolveToolHeaderTemplates({
        record: typedTool.mcp.headers,
        projectId: typedTool.projectId,
        toolContext,
      }),
    };
    return await resolveMcpTools({
      typedTool: {
        mcp,
        actions: typedTool.actions,
        deniedActions: typedTool.deniedActions,
      },
      toolContext,
      buildContextHeaders,
      logToolCallingError,
    });
  } catch (error) {
    // A missing `{{context:...}}` key is a caller error, not a network fault.
    // This swallow exists so an unreachable MCP server does not abort resolution
    // of every other tool; dropping the tool silently here would hide exactly
    // the misconfiguration the token is meant to surface, and the agent would
    // then fail several steps later with "no such tool".
    if (
      error instanceof DomainError &&
      error.code === 'MISSING_TOOL_CONTEXT_KEY'
    ) {
      throw error;
    }
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
  actions: string[] | null;
  deniedActions: string[] | null;
  presetParameters: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  guardrailIds: string[] | null;
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

/**
 * The parameter schema to hand the justification-field injector, or `undefined`
 * to skip injection. Only `http` and `pipeline` tools carry their full
 * model-visible schema in `typedTool.parameters`; `mcp`/`soat` schemas are
 * remote/per-action, so those are gated without justification-field injection.
 */
const localInjectableSchema = (
  typedTool: AgentToolRow
): Record<string, unknown> | undefined => {
  // `http` / `pipeline` carry a local JSON Schema the justification fields can
  // be injected into; `client` tools do too, so a class-C client call can carry
  // model justification onto the approval item at the requires_action handoff.
  if (
    typedTool.type === 'http' ||
    typedTool.type === 'pipeline' ||
    typedTool.type === 'client'
  ) {
    return typedTool.parameters ?? {};
  }
  return undefined;
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
    default:
      return {};
  }
};

const orNull = <T>(value: T | null | undefined): T | null => {
  return value ?? null;
};

const ephemeralDefinitionToRow = (
  definition: InlineToolDefinition,
  projectId: number
): AgentToolRow => {
  return {
    publicId: '',
    projectId,
    type: definition.type ?? 'http',
    name: definition.name,
    description: orNull(definition.description),
    parameters: orNull(
      definition.parameters as Record<string, unknown> | undefined
    ),
    execute: orNull(definition.execute as AgentToolRow['execute']),
    mcp: orNull(definition.mcp as AgentToolRow['mcp']),
    actions: orNull(definition.actions),
    deniedActions: orNull(definition.deniedActions),
    presetParameters: orNull(
      definition.presetParameters as Record<string, unknown> | undefined
    ),
    outputMapping: orNull(
      definition.outputMapping as Record<string, unknown> | undefined
    ),
    // Inline tools are ephemeral and carry no persisted guardrail_ids; only the
    // project/agent base guardrails apply to them.
    guardrailIds: null,
  };
};

/**
 * Resolves an ephemeral (inline, unpersisted) tool definition into an AI-SDK
 * tool — reusing the same `resolveToolByType` dispatch as a persisted Tool
 * row, adapted to a synthetic `AgentToolRow`. `projectId` scopes
 * `{{secret:...}}` resolution for `http`/`mcp` definitions. `pipeline`-type
 * definitions are rejected by `assertEphemeralTypeSupported` before
 * resolution — they have no persisted steps to resolve.
 *
 * That assertion lives in `toolsCall.ts` and is imported statically, via the
 * `tools.ts` re-export. There **is** an import cycle here
 * (`tools` → `toolsCall` → `agentToolResolver` → `tools`), but nothing in this
 * module mitigates it; breaking it is tracked on the orchestration/agent
 * import-cycle work, not worked around locally.
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
  guardrail?: ResolverGuardrailContext;
  activity?: ActivityCallContext;
}): Promise<Record<string, Tool>> => {
  assertEphemeralTypeSupported(args.definition);

  const typedTool = ephemeralDefinitionToRow(args.definition, args.projectId);

  const tools = await resolveToolByType(typedTool, args);
  const mapped = wrapToolsWithOutputMapping(
    recordToolActivity({
      tools,
      toolId: null,
      toolType: typedTool.type,
      toolName: typedTool.name,
      activity: args.activity,
    }),
    typedTool.outputMapping
  );
  const rawParameters =
    typedTool.type === 'http' ? (typedTool.parameters ?? {}) : undefined;

  if (!args.guardrail) return mapped;
  return gateResolvedToolsWithGuardrails({
    tools: mapped,
    // Inline tools have no persisted id to re-execute; the guardrail gate uses
    // a synthetic marker for the proposal, so pass null here.
    toolId: null,
    toolType: typedTool.type,
    toolName: typedTool.name,
    toolGuardrailIds: null,
    presetParameters: typedTool.presetParameters,
    rawParameters,
    context: args.guardrail,
  });
};

type ResolveToolByTypeArgs = {
  projectIds?: number[];
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
};

// Resolves one persisted-tool binding into its (output-mapped, optionally
// guardrail-gated) AI-SDK tools. Extracted so `resolveAgentTools` stays within
// its complexity budget.
const resolveReferenceBinding = async (args: {
  toolPublicId: string;
  projectIds?: number[];
  resolveArgs: ResolveToolByTypeArgs;
  guardrail?: ResolverGuardrailContext;
  activity?: ActivityCallContext;
}): Promise<Record<string, Tool>> => {
  const toolWhere: Record<string, unknown> = { publicId: args.toolPublicId };
  if (args.projectIds !== undefined) {
    toolWhere.projectId = args.projectIds;
  }

  const agentTool = await db.Tool.findOne({ where: toolWhere });
  if (!agentTool) return {};

  const typedTool = agentTool as unknown as AgentToolRow;
  const resolved = await resolveToolByType(typedTool, args.resolveArgs);
  // Activity recording sits innermost, so it only fires for a call that actually
  // reached (and returned from) the tool — see `recordToolActivity`.
  const tools = recordToolActivity({
    tools: resolved,
    toolId: typedTool.publicId,
    toolType: typedTool.type,
    toolName: typedTool.name,
    activity: args.activity,
  });
  // Pipeline tools delegate execution to `callTool` (tools.ts), which already
  // applies `outputMapping` to its return value — wrapping again here would
  // double-apply the mapping.
  const mapped =
    typedTool.type === 'pipeline'
      ? tools
      : wrapToolsWithOutputMapping(tools, typedTool.outputMapping);

  // Guardrails are the single tool-call gating mechanism.
  if (!args.guardrail) return mapped;
  return gateResolvedToolsWithGuardrails({
    tools: mapped,
    toolId: typedTool.publicId,
    toolType: typedTool.type,
    toolName: typedTool.name,
    toolGuardrailIds: typedTool.guardrailIds,
    presetParameters: typedTool.presetParameters,
    rawParameters: localInjectableSchema(typedTool),
    context: args.guardrail,
  });
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
  // Per-generation guardrail-gate context (Milestone 2). Wraps every resolved
  // tool with the classify → route interceptor when a guardrail applies at the
  // project / agent / tool scope.
  guardrail?: ResolverGuardrailContext;
  // Identity a successful tool call is attributed to on the activity feed
  // (approvals PRD Phase 4). Omitted by callers with no agent in scope.
  activity?: ActivityCallContext;
}): Promise<Record<string, Tool>> => {
  const resolvedTools: Record<string, Tool> = {};

  for (const toolPublicId of args.toolIds) {
    Object.assign(
      resolvedTools,
      await resolveReferenceBinding({
        toolPublicId,
        projectIds: args.projectIds,
        resolveArgs: args,
        guardrail: args.guardrail,
        activity: args.activity,
      })
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
        guardrail: args.guardrail,
        activity: args.activity,
      });
      Object.assign(resolvedTools, ephemeralTools);
    }
  }

  return resolvedTools;
};
