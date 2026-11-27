/**
 * The per-type executors behind `callResolvedTool` (`toolsCall.ts`): one
 * outbound call of an `http`, `builtin` or `mcp` tool, metered at the
 * protocol primitive it reaches.
 */
import { DomainError } from '../errors';
import type { AgentAuthority } from './agentAuthority';
import {
  buildHttpToolExecute,
  parseHttpExecuteConfig,
  toHttpToolDomainError,
} from './agentToolResolver';
import { executeSoatTool } from './agentToolResolverExternalTools';
import { buildMcpToolExecute } from './agentToolResolverMcp';
import { type BuiltinAction, findBuiltinAction } from './builtinActionCatalog';
import { callAddedBuiltinAction } from './builtinAddedActions';
import { findDeferredProxy, innerToolName } from './mcpDeferredProxy';
import { fetchMcpToolListing } from './mcpToolListing';
import { type McpTransport, openMcpTransport } from './mcpTransport';
import { buildContextHeaders } from './toolContext';
import type { CallableToolDefinition } from './toolsCall';
import type { ToolExecutionMeter } from './usageToolRecording';
import type { WorkAuthority } from './workAuthority';

const noopLogToolCallingError = () => {};

/** The one refusal for a missing action: it names the request field. */
const requireAction = (args: {
  action: string | undefined;
  type: 'builtin' | 'mcp';
}): string => {
  if (!args.action) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `\`action\` is required for ${args.type} tools.`,
      { field: 'action' }
    );
  }
  return args.action;
};

export const callHttpTool = (
  tool: CallableToolDefinition,
  mergedInput: Record<string, unknown>,
  meter: ToolExecutionMeter,
  call: {
    idempotencyKey?: string;
    toolContext?: Record<string, string>;
    authority: WorkAuthority | null;
    agentAuthority?: AgentAuthority;
    abortSignal?: AbortSignal;
  }
): Promise<unknown> => {
  const { idempotencyKey, toolContext } = call;
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
      projectId: meter.projectId,
      meter,
      contextKeys: tool.contextKeys,
      // Forwarded verbatim as the `Idempotency-Key` request header (D7).
      extraHeaders: idempotencyKey
        ? { 'Idempotency-Key': idempotencyKey }
        : undefined,
      authority: call.authority,
      agentAuthority: call.agentAuthority,
    },
    toolContext
    // Presets were already merged into `mergedInput` by `callResolvedTool`, so
    // none are passed here — passing them again would resolve and merge twice.
  )(mergedInput, { abortSignal: call.abortSignal }).catch((error: unknown) => {
    throw toHttpToolDomainError(error) ?? error;
  });
};

/**
 * The input an action is sent. An input `action` that selected the action is
 * consumed; otherwise it reaches the action only when the action declares
 * `action` itself, as `call-tool` does for its target's action.
 */
const actionInput = (args: {
  found: BuiltinAction;
  input: Record<string, unknown>;
  selectedByInput: boolean;
}): Record<string, unknown> => {
  const { action: _action, ...rest } = args.input;
  void _action;
  if (args.selectedByInput || args.found.kind !== 'native') return rest;
  const properties = args.found.def.inputSchema.properties;
  return properties && Object.hasOwn(properties, 'action') ? args.input : rest;
};

export const callSoatTool = async (
  tool: CallableToolDefinition,
  args: {
    action?: string;
    mergedInput: Record<string, unknown>;
    meter: ToolExecutionMeter;
    authority: WorkAuthority | null;
    toolContext?: Record<string, string>;
    agentAuthority?: AgentAuthority;
    abortSignal?: AbortSignal;
  }
): Promise<unknown> => {
  const { authority } = args;
  const inputAction =
    typeof args.mergedInput['action'] === 'string'
      ? args.mergedInput['action']
      : undefined;
  const action = requireAction({
    action: args.action ?? inputAction,
    type: 'builtin',
  });
  if (!tool.actions?.includes(action)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${action}" is not available on this tool.`
    );
  }
  const found = findBuiltinAction(action);
  if (!found) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${action}" is not a known builtin action.`
    );
  }
  const mergedInput = actionInput({
    found,
    input: args.mergedInput,
    selectedByInput: args.action === undefined,
  });
  if (found.kind === 'added') {
    return callAddedBuiltinAction({
      url: found.url,
      action,
      input: mergedInput,
      meter: args.meter,
      toolContext: args.toolContext,
      contextKeys: tool.contextKeys,
      logToolCallingError: noopLogToolCallingError,
      abortSignal: args.abortSignal,
    });
  }
  const { def } = found;
  return executeSoatTool({
    toolName: tool.name,
    def,
    rawArgs: mergedInput,
    meter: args.meter,
    authority,
    agentAuthority: args.agentAuthority,
    toolContext: args.toolContext,
    contextKeys: tool.contextKeys,
    buildContextHeaders,
    logToolCallingError: noopLogToolCallingError,
    abortSignal: args.abortSignal,
  }).catch((error: unknown) => {
    throw toHttpToolDomainError(error) ?? error;
  });
};

/** Absent `actions` means the whole surface; the denylist wins. */
export const isActionBound = (args: {
  tool: { actions?: string[] | null; deniedActions?: string[] | null };
  action: string;
}): boolean => {
  const { tool, action } = args;
  return (
    (tool.actions == null || tool.actions.includes(action)) &&
    (tool.deniedActions == null || !tool.deniedActions.includes(action))
  );
};

/**
 * Enforced before the outbound request: a scoped tool must reject a denied
 * action at the capability boundary, not merely omit it from the model's tool
 * surface.
 */
const assertActionBound = (args: {
  tool: CallableToolDefinition;
  action: string;
}): void => {
  const { tool, action } = args;
  if (!isActionBound({ tool, action })) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${action}" is not available on this tool.`
    );
  }
};

/**
 * On a deferred server (`mcpDeferredProxy.ts`): the proxy to send `action`
 * through when the server does not list it, or `proxyCall` on a direct call
 * of the proxy, after holding it to the binding's lists by the tool it
 * targets. `schema` is the listed action's input schema; nothing more on a
 * server that lists its tools, and nothing at all when the listing cannot be
 * read.
 */
const deferredRoute = async (args: {
  tool: CallableToolDefinition;
  action: string;
  input: Record<string, unknown>;
  transport: McpTransport;
}): Promise<{ viaCall?: string; proxyCall?: boolean; schema?: unknown }> => {
  const listing = await fetchMcpToolListing({
    transport: args.transport,
    logToolCallingError: noopLogToolCallingError,
  });
  const proxy = listing ? findDeferredProxy(listing) : null;
  if (!listing || !proxy) {
    const listed = listing?.find((mcpTool) => {
      return mcpTool.name === args.action;
    });
    return { schema: listed?.inputSchema };
  }

  if (args.action === proxy.callName) {
    assertActionBound({
      tool: args.tool,
      action: innerToolName(args.input) ?? '',
    });
    return { proxyCall: true };
  }
  const listed = listing.find((mcpTool) => {
    return mcpTool.name === args.action;
  });
  return listed ? { schema: listed.inputSchema } : { viaCall: proxy.callName };
};

/** An `mcp` call ready to send: its transport, its route, its action's schema. */
export type PreparedMcpCall = {
  action: string;
  transport: McpTransport;
  route: { viaCall?: string; proxyCall?: boolean };
  schema?: unknown;
};

/**
 * Opens the call's transport and reads the action's schema, before the call
 * is gated: the presets the gate judges and the call carries are the ones that
 * schema declares (`presetsDeclaredBy`).
 */
export const prepareMcpCall = async (args: {
  tool: CallableToolDefinition;
  action: string | undefined;
  input: Record<string, unknown>;
  meter: ToolExecutionMeter;
  toolContext?: Record<string, string>;
}): Promise<PreparedMcpCall> => {
  const { tool } = args;
  const action = requireAction({ action: args.action, type: 'mcp' });
  assertActionBound({ tool, action });
  const mcpConfig = tool.mcp as {
    url: string;
    headers?: Record<string, string>;
    forward_principal?: boolean;
  } | null;
  if (!mcpConfig?.url) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'MCP tool has an invalid mcp configuration.'
    );
  }
  // A caller with no `tool_context` fails with `MISSING_TOOL_CONTEXT_KEY`
  // naming the key, rather than putting the literal token on the wire as a
  // credential and failing as an opaque upstream 401.
  const transport = await openMcpTransport({
    mcp: mcpConfig,
    meter: args.meter,
    toolContext: args.toolContext,
    contextKeys: tool.contextKeys,
    trust: 'stored',
  });
  const { schema, ...route } = await deferredRoute({
    tool,
    action,
    input: args.input,
    transport,
  });
  return { action, transport, route, schema };
};

/** Sends a call `prepareMcpCall` made ready. */
export const callMcpTool = async (args: {
  prepared: PreparedMcpCall;
  mergedInput: Record<string, unknown>;
  meter: ToolExecutionMeter;
  abortSignal?: AbortSignal;
}): Promise<unknown> => {
  const { prepared } = args;
  return buildMcpToolExecute({
    transport: prepared.transport,
    mcpToolName: prepared.action,
    ...prepared.route,
    meter: args.meter,
    // Presets are merged by `callResolvedTool` on this path, already resolved.
    logToolCallingError: noopLogToolCallingError,
  })(args.mergedInput, { abortSignal: args.abortSignal });
};

export type ServerSideToolProblem = 'runs_on_client' | 'action_required';

const hasPresetAction = (presets: object | null | undefined): boolean => {
  return presets != null && typeof Reflect.get(presets, 'action') === 'string';
};

/**
 * Why a server-side caller could not run this tool, answered as the
 * dispatcher answers it: an `mcp` call takes only an explicit action, a
 * `builtin` call also takes `action` from its merged input. `input` is the
 * caller's fixed presets, or `'open'` when the input arrives with each call.
 */
export const serverSideToolProblem = (args: {
  tool: { type: string; presetParameters: object | null | undefined };
  action: string | null | undefined;
  input: object | null | undefined | 'open';
}): ServerSideToolProblem | null => {
  const { tool, action, input } = args;
  if (tool.type === 'client') return 'runs_on_client';
  if (action) return null;
  if (tool.type === 'mcp') return 'action_required';
  if (tool.type !== 'builtin' || input === 'open') return null;
  return hasPresetAction(tool.presetParameters) || hasPresetAction(input)
    ? null
    : 'action_required';
};

/**
 * Dispatches an `http` or `builtin` tool to its executor; an `mcp` tool goes
 * through `prepareMcpCall` and `callMcpTool`. `client` tools (and any unknown
 * type) cannot run server-side.
 */
export const dispatchDirectTool = async (args: {
  type: string;
  tool: CallableToolDefinition;
  action?: string;
  mergedInput: Record<string, unknown>;
  authority: WorkAuthority | null;
  meter: ToolExecutionMeter;
  idempotencyKey?: string;
  toolContext?: Record<string, string>;
  agentAuthority?: AgentAuthority;
  abortSignal?: AbortSignal;
}): Promise<unknown> => {
  if (args.type === 'http') {
    return callHttpTool(args.tool, args.mergedInput, args.meter, {
      idempotencyKey: args.idempotencyKey,
      toolContext: args.toolContext,
      authority: args.authority,
      agentAuthority: args.agentAuthority,
      abortSignal: args.abortSignal,
    });
  }
  if (args.type === 'builtin') {
    return callSoatTool(args.tool, {
      action: args.action,
      mergedInput: args.mergedInput,
      meter: args.meter,
      authority: args.authority,
      toolContext: args.toolContext,
      agentAuthority: args.agentAuthority,
      abortSignal: args.abortSignal,
    });
  }
  throw new DomainError(
    'TOOL_CALL_NOT_SUPPORTED',
    'Client tools cannot be invoked server-side; they must be executed by the calling client.'
  );
};
