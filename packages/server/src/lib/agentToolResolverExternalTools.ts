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
import {
  agentDenied,
  denialToolResult,
  readForwardedDenial,
} from './authorizationDenial';
import {
  type LogToolCallingError,
  SOAT_TOOL_CALL_TIMEOUT_MS,
} from './externalToolCall';
import { HttpToolError } from './httpToolError';
import { dispatchApiRequestOrThrow, withCallTimeout } from './inProcessApi';
import { resolveSoatActionAgentScope } from './soatActionScope';
import { withoutAgentExcludedActions } from './soatAgentActions';
import { buildSoatActionTarget, soatTools } from './soatTools';
import {
  mergePresetParameters,
  stripPresetKeysFromSchema,
} from './toolPresetParameters';
import { resolvePresetParametersForCall } from './toolTemplates';
import {
  meterToolExecution,
  type ToolExecutionMeter,
} from './usageToolRecording';
import { agentWorkAuthority, type WorkAuthority } from './workAuthority';

const log = createDebug('soat:tools');

/**
 * The authority a builtin call runs under: under `run_as: agent`, the agent's
 * grant in place of the work's; else the work's own.
 */
const soatCallAuthority = (args: {
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}): WorkAuthority | null => {
  const { authority, agentAuthority } = args;
  if (!authority || agentAuthority?.runAs !== 'agent') return authority;
  return agentWorkAuthority({ authority, agent: agentAuthority });
};

/**
 * Invokes a SOAT platform action on behalf of a `soat` tool.
 *
 * Served in-process via `dispatchApiRequest` rather than over loopback:
 * the app's real middleware chain still runs, so permission checks, validation,
 * audit, metering and the response contract are unchanged — only the socket is
 * gone. The work's stored authority travels as a value, never a token; a
 * call without one is refused, since sharing a process never implies sharing
 * authority.
 */
export const executeSoatTool = async (args: {
  toolName: string;
  def: (typeof soatTools)[number];
  rawArgs: Record<string, unknown>;
  meter: ToolExecutionMeter;
  authority: WorkAuthority | null;
  /** Under `run_as: agent`, the call runs under the agent's grant, not `authority`'s. */
  agentAuthority?: AgentAuthority;
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
    log('soat tool execute: %s %s %s', toolId, args.def.method, path);
    // The non-2xx rule is `dispatchApiRequestOrThrow`'s, shared with the MCP
    // surface; only the error type is this caller's — `HttpToolError` carries
    // the status that `isRetriableError` reads to keep a 4xx from being retried.
    return await meterToolExecution({
      meter: args.meter,
      send: (markSent) => {
        markSent({ input: args.rawArgs, action: args.def.name });
        return withCallTimeout({
          promise: dispatchApiRequestOrThrow({
            method: args.def.method,
            path,
            authority: soatCallAuthority(args),
            headers: {
              ...args.buildContextHeaders({
                toolContext: args.toolContext,
                contextKeys: args.contextKeys,
              }),
            },
            body,
            wrapError: (response) => {
              log('soat tool result: %s status=%d', toolId, response.status);
              const denial = readForwardedDenial({ body: response.body });
              if (denial) return denial;
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
      },
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

type IsSoatActionAllowedByAgentPolicy = (args: {
  agentPolicy: unknown;
  iamAction: string;
  resource?: string;
  context?: Record<string, string>;
}) => boolean;

/**
 * The refusal an agent's `policy_ids` gives one builtin call, or `null`
 * when it admits it. Every path that runs a builtin action for an agent asks
 * here, with the arguments the call will carry.
 */
export const soatActionAgentRefusal = async (args: {
  def: (typeof soatTools)[number];
  rawArgs: Record<string, unknown>;
  agentAuthority?: AgentAuthority;
  isSoatActionAllowedByAgentPolicy: IsSoatActionAllowedByAgentPolicy;
}): Promise<ReturnType<typeof denialToolResult> | null> => {
  const { agentAuthority } = args;
  if (!agentAuthority?.policy) return null;
  const iamAction = args.def.iamAction ?? args.def.name;
  // The SRN and tags of whatever this call names, so a boundary scoped to one
  // resource means what it says. `null` leaves the resource-less `*`, which
  // matches no scoped statement, so the unresolved case refuses.
  const scope = await resolveSoatActionAgentScope({
    resourceRef: args.def.resource,
    toolArgs: args.rawArgs,
    agentPolicy: agentAuthority.policy,
  });
  const allowed = args.isSoatActionAllowedByAgentPolicy({
    agentPolicy: agentAuthority.policy,
    iamAction,
    ...(scope ?? {}),
  });
  return allowed
    ? null
    : denialToolResult(
        agentDenied({
          agentId: agentAuthority.agentId,
          action: iamAction,
          resource: scope?.resource ?? null,
        })
      );
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
  isSoatActionAllowedByAgentPolicy: IsSoatActionAllowedByAgentPolicy;
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
      // Merged before the boundary check, not after: a preset or the pinned
      // project can be what names the target, and a check run on the model's
      // arguments alone would refuse a call whose resource the operator
      // supplied.
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
      const refusal = await soatActionAgentRefusal({
        def: args.def,
        rawArgs,
        agentAuthority: args.agentAuthority,
        isSoatActionAllowedByAgentPolicy: args.isSoatActionAllowedByAgentPolicy,
      });
      if (refusal) return refusal;
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
  isSoatActionAllowedByAgentPolicy: IsSoatActionAllowedByAgentPolicy;
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
      isSoatActionAllowedByAgentPolicy: args.isSoatActionAllowedByAgentPolicy,
      logToolCallingError: args.logToolCallingError,
    });
  }
  return result;
};
