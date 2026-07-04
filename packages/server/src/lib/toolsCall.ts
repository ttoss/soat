import { DomainError } from '../errors';
import {
  buildHttpToolExecute,
  parseHttpExecuteConfig,
} from './agentToolResolver';
import {
  buildMcpToolExecute,
  executeSoatTool,
} from './agentToolResolverExternalTools';
import { applyToolOutputMapping } from './jsonLogicMapping';
import type { PipelineStepCaller } from './pipelineTools';
import { runPipeline } from './pipelineTools';
import {
  resolveSecretRefsInRecord,
  resolveSecretRefsInString,
} from './secrets';
import { soatTools } from './soatTools';

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
  projectId: number
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
  return buildHttpToolExecute({
    toolName: tool.name,
    execute: executeConfig,
    projectId,
  })(mergedInput);
};

export const callSoatTool = (
  tool: CallableToolDefinition,
  args: {
    action?: string;
    mergedInput: Record<string, unknown>;
    authHeader?: string;
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
    base: `http://localhost:${process.env.PORT ?? 5047}`,
    authHeader,
    buildContextHeaders: () => {
      return {};
    },
    logToolCallingError: noopLogToolCallingError,
  });
};

export const callMcpTool = async (
  tool: CallableToolDefinition,
  action: string | undefined,
  mergedInput: Record<string, unknown>,
  projectId: number
): Promise<unknown> => {
  if (!action) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'action is required for mcp tools.'
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
  // {{secret:...}} tokens resolve at the point of use, right before the
  // outbound MCP request — the stored config keeps the reference.
  const mcpUrl = await resolveSecretRefsInString({
    value: mcpConfig.url,
    projectId,
  });
  const mcpHeaders = await resolveSecretRefsInRecord({
    record: mcpConfig.headers,
    projectId,
  });
  return buildMcpToolExecute({
    mcpUrl,
    mcpHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(mcpHeaders ?? {}),
    },
    mcpToolName: action,
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
export const callResolvedTool = async (args: {
  tool: CallableToolDefinition;
  toolProjectId: number;
  action?: string;
  input?: Record<string, unknown>;
  authHeader?: string;
  remainingDepth?: number;
  projectIds?: number[];
}): Promise<unknown> => {
  const type = args.tool.type ?? 'http';

  if (type === 'pipeline') {
    const rawResult = await runPipeline({
      pipeline: args.tool.pipeline,
      presetParameters: args.tool.presetParameters,
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
          });
        }
        // Dynamically imported to avoid a circular import — tools.ts imports
        // this module for `callResolvedTool`.
        return import('./tools').then(({ callTool }) => {
          return callTool({
            projectIds: args.projectIds,
            id: step.toolId as string,
            action: step.action,
            input: step.input,
            authHeader: args.authHeader,
            remainingDepth: step.remainingDepth,
          });
        });
      },
    });
    return applyToolOutputMapping(
      (args.tool.outputMapping as Record<string, unknown> | null) ?? null,
      rawResult
    );
  }

  const mergedInput = {
    ...(args.tool.presetParameters ?? {}),
    ...(args.input ?? {}),
  };

  let rawResult: unknown;
  if (type === 'http') {
    rawResult = await callHttpTool(args.tool, mergedInput, args.toolProjectId);
  } else if (type === 'soat') {
    rawResult = await callSoatTool(args.tool, {
      action: args.action,
      mergedInput,
      authHeader: args.authHeader,
    });
  } else if (type === 'mcp') {
    rawResult = await callMcpTool(
      args.tool,
      args.action,
      mergedInput,
      args.toolProjectId
    );
  } else {
    // client tools (and any unknown type) cannot be invoked server-side
    throw new DomainError(
      'TOOL_CALL_NOT_SUPPORTED',
      'Client tools cannot be invoked server-side; they must be executed by the calling client.'
    );
  }

  return applyToolOutputMapping(
    (args.tool.outputMapping as Record<string, unknown> | null) ?? null,
    rawResult
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
}): Promise<unknown> => {
  assertEphemeralTypeSupported(args.definition);
  return callResolvedTool({
    tool: args.definition,
    toolProjectId: args.projectId,
    action: args.action,
    input: args.input,
    authHeader: args.authHeader,
    remainingDepth: args.remainingDepth,
  });
};
