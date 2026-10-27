/**
 * The per-type executors behind `callResolvedTool` (`toolsCall.ts`): one
 * outbound call of an `http`, `builtin` or `mcp` tool, metered at the
 * protocol primitive it reaches.
 */
import { DomainError } from '../errors';
import {
  buildHttpToolExecute,
  isSoatActionAllowedByBoundary,
  parseHttpExecuteConfig,
  toHttpToolDomainError,
} from './agentToolResolver';
import {
  executeSoatTool,
  soatActionBoundaryRefusal,
} from './agentToolResolverExternalTools';
import { buildMcpToolExecute } from './agentToolResolverMcp';
import { findDeferredProxy, innerToolName } from './mcpDeferredProxy';
import { McpToolError } from './mcpProtocol';
import { fetchMcpToolListing } from './mcpToolListing';
import { type McpTransport, openMcpTransport } from './mcpTransport';
import { soatTools } from './soatTools';
import { buildContextHeaders } from './toolContext';
import type { CallableToolDefinition, SignedOffCall } from './toolsCall';
import type { ToolExecutionMeter } from './usageToolRecording';

const noopLogToolCallingError = () => {};

const toMcpToolDomainError = (error: unknown): DomainError | null => {
  if (!(error instanceof McpToolError)) return null;
  // Meta keys are snake_case to match the external REST contract.
  return new DomainError('MCP_TOOL_ERROR', error.message, {
    mcp_tool: error.toolName,
    mcp_url: error.url,
  });
};

export const callHttpTool = (
  tool: CallableToolDefinition,
  mergedInput: Record<string, unknown>,
  meter: ToolExecutionMeter,
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
      projectId: meter.projectId,
      meter,
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

export const callSoatTool = async (
  tool: CallableToolDefinition,
  args: {
    action?: string;
    mergedInput: Record<string, unknown>;
    meter: ToolExecutionMeter;
    authHeader?: string;
    toolContext?: Record<string, string>;
    signedOff?: SignedOffCall;
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
  if (args.signedOff) {
    const refusal = await soatActionBoundaryRefusal({
      def,
      rawArgs: mergedInput,
      boundaryPolicy: args.signedOff.boundaryPolicy,
      isSoatActionAllowedByBoundary,
    });
    if (refusal) return refusal;
  }
  return executeSoatTool({
    toolName: tool.name,
    def,
    rawArgs: mergedInput,
    meter: args.meter,
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

/**
 * Enforced before the outbound request: a scoped tool must reject a denied
 * action at the capability boundary, not merely omit it from the model's tool
 * surface. Absent `actions` means the whole surface; the denylist wins.
 */
const assertActionBound = (args: {
  tool: CallableToolDefinition;
  action: string;
}): void => {
  const { tool, action } = args;
  if (
    (tool.actions != null && !tool.actions.includes(action)) ||
    (tool.deniedActions != null && tool.deniedActions.includes(action))
  ) {
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
  const { tool, action } = args;
  if (!action) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'action is required for mcp tools.'
    );
  }
  assertActionBound({ tool, action });
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
  // A caller with no `tool_context` fails with `MISSING_TOOL_CONTEXT_KEY`
  // naming the key, rather than putting the literal token on the wire as a
  // credential and failing as an opaque upstream 401.
  const transport = await openMcpTransport({
    mcp: mcpConfig,
    meter: args.meter,
    toolContext: args.toolContext,
    contextKeys: tool.contextKeys,
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
}): Promise<unknown> => {
  const { prepared } = args;
  return buildMcpToolExecute({
    transport: prepared.transport,
    mcpToolName: prepared.action,
    ...prepared.route,
    meter: args.meter,
    // Presets are merged by `callResolvedTool` on this path, already resolved.
    logToolCallingError: noopLogToolCallingError,
    // A tool the server itself reported as failed is a `502`, not the `500` an
    // unmapped throw would be: the call reached the server and it answered.
  })(args.mergedInput).catch((error: unknown) => {
    throw toMcpToolDomainError(error) ?? error;
  });
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
  authHeader?: string;
  meter: ToolExecutionMeter;
  idempotencyKey?: string;
  toolContext?: Record<string, string>;
  signedOff?: SignedOffCall;
}): Promise<unknown> => {
  if (args.type === 'http') {
    return callHttpTool(
      args.tool,
      args.mergedInput,
      args.meter,
      args.idempotencyKey,
      args.toolContext
    );
  }
  if (args.type === 'builtin') {
    return callSoatTool(args.tool, {
      action: args.action,
      mergedInput: args.mergedInput,
      meter: args.meter,
      authHeader: args.authHeader,
      toolContext: args.toolContext,
      signedOff: args.signedOff,
    });
  }
  throw new DomainError(
    'TOOL_CALL_NOT_SUPPORTED',
    'Client tools cannot be invoked server-side; they must be executed by the calling client.'
  );
};
