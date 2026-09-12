/**
 * Resolving a `builtin` (SOAT platform action) tool binding, and calling one.
 *
 * The `mcp` half it used to share this file with is in
 * `agentToolResolverMcp.ts`; the two share only `externalToolCall.ts`.
 */
import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

import { buildSoatRequestBody } from './agentToolResolverSoatBody';
import {
  type LogToolCallingError,
  SOAT_TOOL_CALL_TIMEOUT_MS,
} from './externalToolCall';
import { HttpToolError } from './httpToolError';
import { dispatchApiRequestOrThrow, withCallTimeout } from './inProcessApi';
import { withoutAgentExcludedActions } from './soatAgentActions';
import { soatTools } from './soatTools';
import { buildSoatActionTarget } from './soatToolsHelpers';
import {
  mergePresetParameters,
  stripPresetKeysFromSchema,
} from './toolPresetParameters';
import { resolvePresetParametersForCall } from './toolTemplates';

const log = createDebug('soat:tools');

/**
 * Invokes a SOAT platform action on behalf of a `soat` tool.
 *
 * Served in-process via `dispatchApiRequest` rather than over loopback (#888):
 * the app's real middleware chain still runs, so permission checks, validation,
 * audit, metering and the response contract are unchanged — only the socket is
 * gone. `authHeader` keeps its meaning; a call without one is refused by the
 * same middleware, since sharing a process never implies sharing authority.
 */
export const executeSoatTool = async (args: {
  toolName: string;
  def: (typeof soatTools)[number];
  rawArgs: Record<string, unknown>;
  authHeader?: string;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  logToolCallingError: LogToolCallingError;
}) => {
  // Path *and* query string: `def.path(...)` alone substitutes path parameters
  // only, discarding every `in: query` parameter the action advertises (#924).
  const path = buildSoatActionTarget({ def: args.def, args: args.rawArgs });
  const body = buildSoatRequestBody({
    def: args.def,
    rawArgs: args.rawArgs,
    toolContext: args.toolContext,
    contextKeys: args.contextKeys,
    traceId: args.traceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
  });
  const toolId = `${args.toolName}_${args.def.name}`;
  try {
    log('soat tool execute: %s %s %s', toolId, args.def.method, path);
    // The non-2xx rule is `dispatchApiRequestOrThrow`'s, shared with the MCP
    // surface; only the error type is this caller's — `HttpToolError` carries
    // the status that `isRetriableError` reads to keep a 4xx from being retried.
    return await withCallTimeout({
      promise: dispatchApiRequestOrThrow({
        method: args.def.method,
        path,
        headers: {
          ...(args.authHeader ? { Authorization: args.authHeader } : {}),
          ...args.buildContextHeaders({
            toolContext: args.toolContext,
            contextKeys: args.contextKeys,
          }),
        },
        body,
        wrapError: (response) => {
          log('soat tool result: %s status=%d', toolId, response.status);
          return new HttpToolError(
            `SOAT action '${args.def.name}' failed`,
            response.status,
            JSON.stringify(response.body) ?? '',
            path,
            args.def.method
          );
        },
      }),
      ms: SOAT_TOOL_CALL_TIMEOUT_MS,
      label: `SOAT action '${args.def.name}'`,
    });
  } catch (error) {
    log('soat tool error: %s', toolId);
    args.logToolCallingError({
      toolName: toolId,
      toolType: 'builtin',
      url: path,
      method: args.def.method,
      error,
    });
    throw error;
  }
};

/**
 * The generation's project, pinned onto every builtin action that names one.
 *
 * `project_id` decides which project the call acts on, and a bearer spanning
 * several is ordinary — so left to the model it is a choice, and the agent can
 * act outside the project it was invoked in. Merged after the tool's own
 * presets so neither the model's argument nor an operator's preset can move it,
 * and stripped from the schema so it is not something to guess at.
 *
 * Only the keys an operation declares are read when the request is built, so
 * this is inert on an action that names no project.
 */
const pinnedProjectParameters = (
  projectPublicId?: string
): Record<string, unknown> => {
  return projectPublicId ? { project_id: projectPublicId } : {};
};

const buildSoatActionTool = (args: {
  toolName: string;
  toolDescription: string | null;
  def: (typeof soatTools)[number];
  presetParameters?: Record<string, unknown>;
  projectPublicId?: string;
  boundaryPolicy?: unknown;
  authHeader?: string;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  isSoatActionAllowedByBoundary: (args: {
    boundaryPolicy: unknown;
    iamAction: string;
  }) => boolean;
  logToolCallingError: LogToolCallingError;
}): Tool => {
  const pinned = pinnedProjectParameters(args.projectPublicId);
  const effectiveInputSchema = stripPresetKeysFromSchema(
    args.def.inputSchema as JSONSchema7,
    { ...args.presetParameters, ...pinned }
  );
  return tool({
    description: args.toolDescription ?? args.def.description,
    inputSchema: jsonSchema(effectiveInputSchema),
    execute: async (toolArgs: unknown) => {
      const iamAction = args.def.iamAction ?? args.def.name;
      if (
        !args.isSoatActionAllowedByBoundary({
          boundaryPolicy: args.boundaryPolicy,
          iamAction,
        })
      ) {
        return { error: `Forbidden: boundary policy denies ${iamAction}` };
      }
      const rawArgs = mergePresetParameters({
        presetParameters: {
          ...resolvePresetParametersForCall({
            presetParameters: args.presetParameters,
            toolContext: args.toolContext,
            toolName: args.toolName,
            schema: args.def.inputSchema,
          }),
          ...pinned,
        },
        input: toolArgs,
      });
      return executeSoatTool({
        toolName: args.toolName,
        def: args.def,
        rawArgs,
        authHeader: args.authHeader,
        toolContext: args.toolContext,
        contextKeys: args.contextKeys,
        traceId: args.traceId,
        rootTraceId: args.rootTraceId,
        remainingDepth: args.remainingDepth,
        buildContextHeaders: args.buildContextHeaders,
        logToolCallingError: args.logToolCallingError,
      });
    },
  });
};

export const resolveSoatTools = (args: {
  typedTool: {
    name: string;
    description: string | null;
    actions: string[] | null;
    presetParameters?: Record<string, unknown> | null;
    contextKeys?: string[] | null;
  };
  boundaryPolicy?: unknown;
  authHeader?: string;
  /** The project the generation runs in; see `pinnedProjectParameters`. */
  projectPublicId?: string;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  isSoatActionAllowedByBoundary: (args: {
    boundaryPolicy: unknown;
    iamAction: string;
  }) => boolean;
  logToolCallingError: LogToolCallingError;
}): Record<string, Tool> => {
  const result: Record<string, Tool> = {};
  // A row written before an action was excluded still names it, and the write
  // that refuses it now cannot reach what is already stored — so the surface
  // is filtered here too rather than trusting the binding.
  const actions = withoutAgentExcludedActions({
    actions: args.typedTool.actions ?? [],
    toolName: args.typedTool.name,
  });
  for (const action of actions) {
    const def = soatTools.find((t) => {
      return t.name === action;
    });
    if (!def) continue;
    const resolvedToolName = `${args.typedTool.name}_${action}`;
    result[resolvedToolName] = buildSoatActionTool({
      toolName: args.typedTool.name,
      toolDescription: args.typedTool.description,
      def,
      presetParameters: args.typedTool.presetParameters ?? undefined,
      projectPublicId: args.projectPublicId,
      boundaryPolicy: args.boundaryPolicy,
      authHeader: args.authHeader,
      toolContext: args.toolContext,
      contextKeys: args.typedTool.contextKeys,
      traceId: args.traceId,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
      remainingDepth: args.remainingDepth,
      buildContextHeaders: args.buildContextHeaders,
      isSoatActionAllowedByBoundary: args.isSoatActionAllowedByBoundary,
      logToolCallingError: args.logToolCallingError,
    });
  }
  return result;
};
