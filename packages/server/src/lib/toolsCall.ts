import { DomainError } from '../errors';
import {
  buildHttpToolExecute,
  parseHttpExecuteConfig,
} from './agentToolResolver';
import {
  buildMcpToolExecute,
  executeSoatTool,
} from './agentToolResolverExternalTools';
import {
  resolveSecretRefsInRecord,
  resolveSecretRefsInString,
} from './secrets';
import { soatTools } from './soatTools';
import type { MappedTool } from './tools';

const noopLogToolCallingError = () => {};

export const callHttpTool = (
  tool: MappedTool,
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
  tool: MappedTool,
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
  tool: MappedTool,
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
