import { DomainError } from '../errors';
import {
  buildHttpToolExecute,
  parseHttpExecuteConfig,
  toHttpToolDomainError,
} from './agentToolResolver';
import {
  buildMcpToolExecute,
  executeSoatTool,
} from './agentToolResolverExternalTools';
import { applyToolOutputMapping } from './jsonLogicMapping';
import type { PipelineStepCaller } from './pipelineTools';
import { runPipeline } from './pipelineTools';
import { resolveSecretRefsInString } from './secrets';
import { soatTools } from './soatTools';
import { buildContextHeaders } from './toolContext';
import { mergePresetParameters } from './toolPresetParameters';
import { callTool } from './tools';
import {
  resolvePresetParametersForCall,
  resolveToolHeaderTemplates,
} from './toolTemplates';

const noopLogToolCallingError = () => {};

// ── Shared Tool Definition Types ─────────────────────────────────────────────

// An inline/ephemeral tool definition — the fields needed to describe a tool
// without a `projectId` (always the owning resource's own project: an agent's,
// or a pipeline tool's). `tools.ts#CreateToolArgs` extends this with
// `projectId` for persisted Tool rows.
export type InlineToolDefinition = {
  type?: string;
  name: string;
  description?: string;
  parameters?: object;
  execute?: object;
  mcp?: object;
  actions?: string[];
  deniedActions?: string[];
  contextKeys?: string[] | null;
  presetParameters?: object;
  pipeline?: object;
  outputMapping?: object;
};

// The fields `callResolvedTool` (and `callHttpTool`/`callSoatTool`/
// `callMcpTool` below) actually read off a tool — a `MappedTool` (persisted,
// DB-backed) and an `InlineToolDefinition` (ephemeral) both satisfy this
// shape, which is what lets both execution paths share one implementation.
export type CallableToolDefinition = {
  name: string;
  type?: string | null;
  description?: string | null;
  parameters?: object | null;
  execute?: object | null;
  mcp?: object | null;
  actions?: string[] | null;
  deniedActions?: string[] | null;
  contextKeys?: string[] | null;
  presetParameters?: object | null;
  pipeline?: object | null;
  outputMapping?: object | null;
};

/**
 * Ephemeral tool definitions (an agent's inline `tools`, a pipeline step's
 * inline `tool`) are resolved/executed directly from their definition without
 * a persisted Tool row, so a `pipeline` type — which resolves its steps by
 * looking up other Tool rows by ID — has nothing to resolve against. Nest a
 * persisted pipeline tool (`POST /tools`) and reference it by ID instead.
 */
export const assertEphemeralTypeSupported = (
  definition: InlineToolDefinition
): void => {
  if (definition.type === 'pipeline') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Ephemeral tool definitions of type "pipeline" are not supported; create a persisted pipeline tool via POST /tools and reference it by ID instead.'
    );
  }
};

export const callHttpTool = (
  tool: CallableToolDefinition,
  mergedInput: Record<string, unknown>,
  projectId: number,
  idempotencyKey?: string,
  toolContext?: Record<string, string>
): Promise<unknown> => {
  const executeConfig = parseHttpExecuteConfig(
    (tool.execute as
      | { url: string; method?: string; headers?: Record<string, string> }
      | string
      | null) ?? null
  );
  if (!executeConfig) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'HTTP tool has an invalid execute configuration.'
    );
  }
  return buildHttpToolExecute(
    {
      toolName: tool.name,
      execute: executeConfig,
      projectId,
      contextKeys: tool.contextKeys,
      // Forwarded verbatim as the `Idempotency-Key` request header (D7).
      extraHeaders: idempotencyKey
        ? { 'Idempotency-Key': idempotencyKey }
        : undefined,
    },
    toolContext
    // Presets were already merged into `mergedInput` by `callResolvedTool`, so
    // none are passed here — passing them again would resolve and merge twice.
  )(mergedInput).catch((error: unknown) => {
    throw toHttpToolDomainError(error) ?? error;
  });
};

export const callSoatTool = (
  tool: CallableToolDefinition,
  args: {
    action?: string;
    mergedInput: Record<string, unknown>;
    authHeader?: string;
    toolContext?: Record<string, string>;
  }
): Promise<unknown> => {
  const { authHeader } = args;
  // Support presetParameters.action as a fallback when no explicit action is given.
  const action =
    args.action ??
    (typeof args.mergedInput['action'] === 'string'
      ? args.mergedInput['action']
      : undefined);
  // Strip 'action' from the inputs so it is not forwarded as a tool parameter.
  const { action: _action, ...mergedInput } = args.mergedInput;
  void _action;
  if (!action) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'operationId is required for soat tools.'
    );
  }
  if (!tool.actions?.includes(action)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${action}" is not available on this tool.`
    );
  }
  const def = soatTools.find((t) => {
    return t.name === action;
  });
  if (!def) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${action}" is not a known SOAT action.`
    );
  }
  return executeSoatTool({
    toolName: tool.name,
    def,
    rawArgs: mergedInput,
    authHeader,
    toolContext: args.toolContext,
    contextKeys: tool.contextKeys,
    buildContextHeaders,
    logToolCallingError: noopLogToolCallingError,
    // Same mapping `callHttpTool` applies: the self-call's real status reaches
    // the caller as `meta.tool_status_code`, which is also what
    // `isRetriableError` reads to keep a 4xx from being retried.
  }).catch((error: unknown) => {
    throw toHttpToolDomainError(error) ?? error;
  });
};

export const callMcpTool = async (
  tool: CallableToolDefinition,
  action: string | undefined,
  mergedInput: Record<string, unknown>,
  projectId: number,
  toolContext?: Record<string, string>
): Promise<unknown> => {
  if (!action) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'action is required for mcp tools.'
    );
  }
  // When the tool declares an `actions` allowlist and/or a `deniedActions`
  // denylist, enforce them before the outbound MCP request — a scoped (e.g.
  // read-only) tool must reject a denied action at the capability boundary,
  // not merely omit it from the model's tool surface. `null`/`undefined`
  // `actions` means the whole server surface; the denylist takes precedence.
  if (tool.actions != null && !tool.actions.includes(action)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${action}" is not available on this tool.`
    );
  }
  if (tool.deniedActions != null && tool.deniedActions.includes(action)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${action}" is not available on this tool.`
    );
  }
  const mcpConfig = tool.mcp as {
    url: string;
    headers?: Record<string, string>;
  } | null;
  if (!mcpConfig?.url) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'MCP tool has an invalid mcp configuration.'
    );
  }
  // Template tokens resolve at the point of use, right before the outbound MCP
  // request — the stored config keeps the reference.
  //
  // A caller that carries no `tool_context` (a direct `POST /tools/{id}/call`)
  // fails a header holding a `{{context:...}}` token with
  // `MISSING_TOOL_CONTEXT_KEY` naming the key. That is deliberate: the
  // alternative is putting the literal `{{context:...}}` text on the wire as a
  // credential, which fails as an opaque upstream 401 instead.
  const mcpUrl = await resolveSecretRefsInString({
    value: mcpConfig.url,
    projectId,
  });
  const mcpHeaders = await resolveToolHeaderTemplates({
    record: mcpConfig.headers,
    projectId,
    toolContext,
  });
  return buildMcpToolExecute({
    mcpUrl,
    mcpHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(mcpHeaders ?? {}),
      ...buildContextHeaders({ toolContext, contextKeys: tool.contextKeys }),
    },
    mcpToolName: action,
    // Presets are merged by `callResolvedTool` on this path, already resolved.
    logToolCallingError: noopLogToolCallingError,
  })(mergedInput);
};

// ── Resolved Tool Execution ───────────────────────────────────────────────

/**
 * Executes an already-resolved tool definition — shared by `tools.ts#callTool`
 * (looks up a persisted Tool row first) and `callEphemeralTool` (executes an
 * inline definition directly, no DB row). `toolProjectId` scopes
 * `{{secret:...}}` resolution for `http`/`mcp` tools.
 *
 * A pipeline step's `callStep` dispatches inline here (rather than through a
 * separate named helper calling back into `callEphemeralTool`) so this stays
 * a single self-recursive function instead of two consts referencing each
 * other out of declaration order.
 */
/**
 * Dispatches a non-pipeline tool to its per-type executor. `client` tools (and
 * any unknown type) cannot run server-side.
 */
const dispatchDirectTool = async (args: {
  type: string;
  tool: CallableToolDefinition;
  action?: string;
  mergedInput: Record<string, unknown>;
  authHeader?: string;
  toolProjectId: number;
  idempotencyKey?: string;
  toolContext?: Record<string, string>;
}): Promise<unknown> => {
  if (args.type === 'http') {
    return callHttpTool(
      args.tool,
      args.mergedInput,
      args.toolProjectId,
      args.idempotencyKey,
      args.toolContext
    );
  }
  if (args.type === 'builtin') {
    return callSoatTool(args.tool, {
      action: args.action,
      mergedInput: args.mergedInput,
      authHeader: args.authHeader,
      toolContext: args.toolContext,
    });
  }
  if (args.type === 'mcp') {
    return callMcpTool(
      args.tool,
      args.action,
      args.mergedInput,
      args.toolProjectId,
      args.toolContext
    );
  }
  throw new DomainError(
    'TOOL_CALL_NOT_SUPPORTED',
    'Client tools cannot be invoked server-side; they must be executed by the calling client.'
  );
};

export const callResolvedTool = async (args: {
  tool: CallableToolDefinition;
  toolProjectId: number;
  action?: string;
  input?: Record<string, unknown>;
  authHeader?: string;
  remainingDepth?: number;
  projectIds?: number[];
  idempotencyKey?: string;
  // The caller's `tool_context` — an orchestration run's bag on a `tool`/`poll`
  // node, the parent call's on a pipeline step. It resolves `{{context:}}` in
  // this tool's headers and presets, and is forwarded as context headers.
  toolContext?: Record<string, string>;
}): Promise<unknown> => {
  const type = args.tool.type ?? 'http';

  // Resolved once, here, so every dispatch below (and the pipeline's own merge)
  // sees the same values — the presets reach `callHttpTool`/`callMcpTool`
  // already merged, and are not resolved a second time there.
  const presetParameters = resolvePresetParametersForCall({
    presetParameters: args.tool.presetParameters,
    toolContext: args.toolContext,
    toolName: args.tool.name,
    schema: args.tool.parameters,
  });

  const mergedInput = mergePresetParameters({
    presetParameters,
    input: args.input,
  });

  if (type === 'pipeline') {
    const rawResult = await runPipeline({
      pipeline: args.tool.pipeline,
      presetParameters,
      input: args.input,
      remainingDepth: args.remainingDepth,
      callStep: (step: Parameters<PipelineStepCaller>[0]) => {
        if (step.tool) {
          assertEphemeralTypeSupported(step.tool);
          return callResolvedTool({
            tool: step.tool,
            toolProjectId: args.toolProjectId,
            action: step.action,
            input: step.input,
            authHeader: args.authHeader,
            remainingDepth: step.remainingDepth,
            // A step is the pipeline's own work, so it inherits the context the
            // pipeline was called with — the same rule a nested orchestration
            // run follows (#945).
            toolContext: args.toolContext,
          });
        }
        return callTool({
          projectIds: args.projectIds,
          id: step.toolId as string,
          action: step.action,
          input: step.input,
          authHeader: args.authHeader,
          remainingDepth: step.remainingDepth,
          toolContext: args.toolContext,
        });
      },
    });
    return applyToolOutputMapping(
      (args.tool.outputMapping as Record<string, unknown> | null) ?? null,
      rawResult,
      mergedInput
    );
  }

  const rawResult = await dispatchDirectTool({
    type,
    tool: args.tool,
    action: args.action,
    mergedInput,
    authHeader: args.authHeader,
    toolProjectId: args.toolProjectId,
    idempotencyKey: args.idempotencyKey,
    toolContext: args.toolContext,
  });

  return applyToolOutputMapping(
    (args.tool.outputMapping as Record<string, unknown> | null) ?? null,
    rawResult,
    mergedInput
  );
};

/**
 * Executes an ephemeral tool definition directly — no persisted Tool row.
 * Used by pipeline steps that inline a `tool` definition instead of
 * referencing an existing tool by `tool_id`, and by agents' inline `tools`.
 */
export const callEphemeralTool = async (args: {
  definition: InlineToolDefinition;
  projectId: number;
  action?: string;
  input?: Record<string, unknown>;
  authHeader?: string;
  remainingDepth?: number;
  toolContext?: Record<string, string>;
}): Promise<unknown> => {
  assertEphemeralTypeSupported(args.definition);
  return callResolvedTool({
    tool: args.definition,
    toolProjectId: args.projectId,
    action: args.action,
    input: args.input,
    authHeader: args.authHeader,
    remainingDepth: args.remainingDepth,
    toolContext: args.toolContext,
  });
};
