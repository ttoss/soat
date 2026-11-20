/**
 * Resolving a `builtin` (SOAT platform action) tool binding, and calling one.
 *
 * The `mcp` half lives in `agentToolResolverMcp.ts`; the two share only
 * `externalToolCall.ts`.
 */
import type { JSONSchema7, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import createDebug from 'debug';

import type { AgentAuthority } from './agentAuthority';
import { buildSoatRequestBody } from './agentToolResolverSoatBody';
import { readForwardedDenial } from './authorizationDenial';
import {
  builtinActionToolName,
  findBuiltinAction,
} from './builtinActionCatalog';
import { builtinActionError } from './builtinActionError';
import { type LogToolCallingError } from './externalToolCall';
import { type HandoffCall, handoffFor } from './generationHandoff';
import { dispatchApiRequestOrThrow } from './inProcessApi';
import { withoutAgentExcludedActions } from './soatAgentActions';
import { buildSoatActionTarget, type ToolDefinition } from './soatTools';
import {
  mergePresetParameters,
  stripPresetKeysFromSchema,
} from './toolPresetParameters';
import { resolvePresetParametersForCall } from './toolTemplates';
import { turnAuthority } from './turnAuthority';
import {
  meterToolExecution,
  type ToolExecutionMeter,
} from './usageToolRecording';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:tools');

/**
 * Invokes a SOAT platform action on behalf of a `builtin` tool.
 *
 * Served in-process via `dispatchApiRequest` rather than over loopback:
 * the app's real middleware chain still runs, so permission checks, validation,
 * audit, metering and the response contract are unchanged — only the socket is
 * gone. The turn's authority (`turnAuthority`) travels as a value, never a
 * token, so the route's own check is the agent's gate; a call without one is
 * refused, since sharing a process never implies sharing authority.
 */
export const executeSoatTool = async (args: {
  toolName: string;
  def: ToolDefinition;
  rawArgs: Record<string, unknown>;
  meter: ToolExecutionMeter;
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  rootTraceId?: string | null;
  remainingDepth?: number;
  /** The tool call this is, within its generation; absent outside a turn. */
  call?: HandoffCall | null;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
  logToolCallingError: LogToolCallingError;
}) => {
  const handoff = handoffFor(args);
  // The template until the target is built: building refuses a call missing a
  // path argument, and that refusal is logged like any other failed call.
  let path = args.def.pathTemplate;
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
    // Path *and* query string: `def.path(...)` alone substitutes path
    // parameters only, discarding every `in: query` parameter the action
    // advertises.
    path = buildSoatActionTarget({ def: args.def, args: args.rawArgs });
    log('builtin tool execute: %s %s %s', toolId, args.def.method, path);
    // The non-2xx rule is `dispatchApiRequestOrThrow`'s, shared with the MCP
    // surface; only the error is this caller's: `meta.tool_status_code` is
    // what `isRetriableError` reads to keep a 4xx from being retried.
    return await meterToolExecution({
      meter: args.meter,
      send: (markSent) => {
        markSent({ input: args.rawArgs, action: args.def.name });
        return handoff.wait(
          dispatchApiRequestOrThrow({
            method: args.def.method,
            path,
            as: {
              authority: turnAuthority(args),
              actor: args.toolContext?.actor_id ?? null,
              call: args.call,
            },
            headers: handoff.headers,
            body,
            wrapError: (response) => {
              log('builtin tool result: %s status=%d', toolId, response.status);
              const denial = readForwardedDenial({ body: response.body });
              if (denial) return denial;
              return builtinActionError({
                action: args.def.name,
                method: args.def.method,
                response,
              });
            },
          })
        );
      },
    });
  } catch (error) {
    log('builtin tool error: %s', toolId);
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
  def: ToolDefinition;
  meter: ToolExecutionMeter;
  presetParameters?: Record<string, unknown>;
  projectPublicId?: string;
  agentAuthority?: AgentAuthority;
  authority: WorkAuthority | null;
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
    execute: async (toolArgs: unknown, options: { toolCallId: string }) => {
      const generationId = args.meter.attribution.generationId;
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
        meter: args.meter,
        authority: args.authority,
        agentAuthority: args.agentAuthority,
        toolContext: args.toolContext,
        contextKeys: args.contextKeys,
        traceId: args.traceId,
        rootTraceId: args.rootTraceId,
        remainingDepth: args.remainingDepth,
        call: generationId
          ? { generationId, toolCallId: options.toolCallId }
          : null,
        buildContextHeaders: args.buildContextHeaders,
        logToolCallingError: args.logToolCallingError,
      });
    },
  });
};

/** The native actions of a `builtin` tool; `resolveAddedBuiltinActions` resolves the added ones. */
export const resolveSoatTools = (args: {
  typedTool: {
    name: string;
    description: string | null;
    actions: string[] | null;
    presetParameters?: Record<string, unknown> | null;
    contextKeys?: string[] | null;
  };
  meter: ToolExecutionMeter;
  agentAuthority?: AgentAuthority;
  authority: WorkAuthority | null;
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
    // A stored row keeps a name the deployment no longer offers; it resolves
    // to nothing rather than to the action the catalog withholds.
    const found = findBuiltinAction(action);
    if (found?.kind !== 'native') continue;
    const { def } = found;
    const resolvedToolName = builtinActionToolName({
      toolName: args.typedTool.name,
      action,
    });
    result[resolvedToolName] = buildSoatActionTool({
      toolName: args.typedTool.name,
      toolDescription: args.typedTool.description,
      def,
      meter: args.meter,
      presetParameters: args.typedTool.presetParameters ?? undefined,
      projectPublicId: args.projectPublicId,
      agentAuthority: args.agentAuthority,
      authority: args.authority,
      toolContext: args.toolContext,
      contextKeys: args.typedTool.contextKeys,
      traceId: args.traceId,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
      remainingDepth: args.remainingDepth,
      buildContextHeaders: args.buildContextHeaders,
      logToolCallingError: args.logToolCallingError,
    });
  }
  return result;
};
