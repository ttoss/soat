/**
 * Resolving and calling the actions a deployment adds to `builtin`
 * (`builtinActionCatalog.ts`): each is a tool its registered MCP server
 * serves, reached through `postMcp`, so every request carries the signed tool
 * assertion, and described by that server's listing.
 */
import type { Tool } from 'ai';
import createDebug from 'debug';

import { buildMcpToolExecute, resolveMcpTools } from './agentToolResolverMcp';
import {
  builtinActionToolName,
  findBuiltinAction,
} from './builtinActionCatalog';
import type { LogToolCallingError } from './externalToolCall';
import { openMcpTransport } from './mcpTransport';
import type { ToolExecutionMeter } from './usageToolRecording';

const log = createDebug('soat:tools');

type AddedBinding = {
  meter: ToolExecutionMeter;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
};

const openTransport = (args: AddedBinding & { url: string }) => {
  return openMcpTransport({
    mcp: { url: args.url },
    meter: args.meter,
    toolContext: args.toolContext,
    contextKeys: args.contextKeys,
    trust: 'catalog',
  });
};

/**
 * The added actions among a `builtin` tool's `actions`, each named
 * `<toolName>_<action>` like a native one; `resolveSoatTools` resolves the
 * native ones.
 */
export const resolveAddedBuiltinActions = async (
  args: AddedBinding & {
    toolName: string;
    actions: string[];
    presetParameters?: Record<string, unknown> | null;
    presetParametersByAction?: object | null;
    logToolCallingError: LogToolCallingError;
    reportResolutionFailure?: (args: { reason: string }) => void;
  }
): Promise<Record<string, Tool>> => {
  const added = args.actions.flatMap((name) => {
    const found = findBuiltinAction(name);
    return found?.kind === 'added' ? [found] : [];
  });
  if (added.length === 0) return {};
  // The catalog adds actions from one server.
  const { url } = added[0];
  const names = added.map((found) => {
    return found.name;
  });
  log(
    'resolveAddedBuiltinActions: tool=%s url=%s actions=%o',
    args.toolName,
    url,
    names
  );
  const resolved = await resolveMcpTools({
    transport: await openTransport({ ...args, url }),
    typedTool: {
      actions: names,
      presetParameters: args.presetParameters,
      presetParametersByAction: args.presetParametersByAction,
    },
    meter: args.meter,
    toolContext: args.toolContext,
    logToolCallingError: args.logToolCallingError,
    reportResolutionFailure: args.reportResolutionFailure,
  });
  return Object.fromEntries(
    Object.entries(resolved).map(([action, tool]) => {
      return [builtinActionToolName({ toolName: args.toolName, action }), tool];
    })
  );
};

/** One direct call of an added action, its presets already merged into `input`. */
export const callAddedBuiltinAction = async (
  args: AddedBinding & {
    url: string;
    action: string;
    input: Record<string, unknown>;
    logToolCallingError: LogToolCallingError;
    abortSignal?: AbortSignal;
  }
): Promise<unknown> => {
  log('callAddedBuiltinAction: url=%s action=%s', args.url, args.action);
  return buildMcpToolExecute({
    transport: await openTransport(args),
    mcpToolName: args.action,
    meter: args.meter,
    logToolCallingError: args.logToolCallingError,
  })(args.input, { abortSignal: args.abortSignal });
};
