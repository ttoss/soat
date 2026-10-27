import { db } from '../db';
import { DomainError } from '../errors';
import { actionOfType, applyToolOutputMapping } from './jsonLogicMapping';
import { readRunTokenWork } from './orchestrationRunToken';
import type { PipelineStepCaller } from './pipelineTools';
import { runPipeline } from './pipelineTools';
import { admitSharedCall } from './shareCaps';
import {
  assertToolCallAllowed,
  type ToolCallGuardrailMode,
} from './toolCallGuardrail';
import { pinCallingProject } from './toolContext';
import {
  mergePresetParameters,
  presetsDeclaredBy,
} from './toolPresetParameters';
import { callTool } from './tools';
import {
  callMcpTool,
  dispatchDirectTool,
  type PreparedMcpCall,
  prepareMcpCall,
} from './toolsCallDispatch';
import { resolvePresetParametersForCall } from './toolTemplates';
import {
  meterToolExecution,
  type ToolCallAttribution,
  type ToolExecutionMeter,
  withReleasingGuardrails,
} from './usageToolRecording';

// ── Shared Tool Definition Types ─────────────────────────────────────────────

// A tool described without a `projectId` — always the owning resource's own.
// `tools.ts#CreateToolArgs` adds it back for persisted rows.
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

// The fields the call paths actually read. Both `MappedTool` and
// `InlineToolDefinition` satisfy this, which is what lets them share one
// implementation.
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

// ── Resolved Tool Execution ───────────────────────────────────────────────

/**
 * Executes an already-resolved tool definition — `tools.ts#callTool` looks up
 * the persisted Tool row first, and a pipeline's inline step definition is
 * dispatched here directly with no DB row. `toolProjectId` scopes
 * `{{secret:...}}` resolution for `http`/`mcp` tools.
 */
/** Whether the call runs another project's tool, reached through a share. */
const isCrossProject = (args: {
  toolProjectId: number;
  callerProjectId: number;
}): boolean => {
  return args.callerProjectId !== args.toolProjectId;
};

/**
 * Runs the guardrail gate unless a gate upstream already classified this call,
 * and answers with the arguments dispatch should carry.
 */
const adjudicate = async (gateArgs: {
  args: {
    tool: CallableToolDefinition;
    toolProjectId: number;
    callerProjectId: number;
    guardrails: ToolCallGuardrailMode;
    toolPublicId?: string | null;
    toolGuardrailIds?: string[] | null;
    action?: string;
    input?: Record<string, unknown>;
    authHeader?: string;
  };
  presetParameters: Record<string, unknown> | null;
}): Promise<{ input: Record<string, unknown>; guardrailIds: string[] }> => {
  const { args, presetParameters } = gateArgs;
  if (args.guardrails !== 'apply') {
    return { input: args.input ?? {}, guardrailIds: [] };
  }

  return assertToolCallAllowed({
    toolId: args.toolPublicId ?? null,
    toolName: args.tool.name,
    toolGuardrailIds: isCrossProject(args) ? null : args.toolGuardrailIds,
    action: args.action,
    input: args.input ?? {},
    presetParameters,
    projectId: args.callerProjectId,
    authHeader: args.authHeader,
  });
};

/**
 * A call a human signed off on. Its presets are the values the proposal froze
 * into `frozenArguments`, never re-resolved from the resolving request's
 * `tool_context`, and a `builtin` action stays within the proposing agent's
 * `boundaryPolicy`.
 */
export type SignedOffCall = {
  frozenArguments: Record<string, unknown>;
  boundaryPolicy: unknown;
};

/**
 * The tool's presets with each key the sign-off froze taking its frozen value;
 * a key the proposal did not carry keeps its stored template.
 */
const frozenPresets = (args: {
  presetParameters?: object | null;
  frozenArguments: Record<string, unknown>;
}): Record<string, unknown> | null => {
  if (!args.presetParameters) return null;
  return Object.fromEntries(
    Object.entries(args.presetParameters).map(([key, value]) => {
      return [
        key,
        Object.hasOwn(args.frozenArguments, key)
          ? args.frozenArguments[key]
          : value,
      ];
    })
  );
};

type CallResolvedToolArgs = {
  tool: CallableToolDefinition;
  toolProjectId: number;
  /**
   * The project the call is metered and gated in — the tool's own project, or
   * the caller's when the tool is another project's, reached through a share.
   * The tool's own guardrails name guardrails in its project, so they do not
   * apply to a shared call.
   */
  callerProjectId: number;
  /**
   * Whether a guardrail gate has already adjudicated this call. Required, so a
   * dispatch path cannot reach a tool without saying which it is — every path
   * that skipped the gate skipped it by omission rather than by decision.
   */
  guardrails: ToolCallGuardrailMode;
  /** The persisted tool's id and scope, for the gate. Absent for an ephemeral definition. */
  toolPublicId?: string | null;
  toolGuardrailIds?: string[] | null;
  action?: string;
  input?: Record<string, unknown>;
  authHeader?: string;
  remainingDepth?: number;
  idempotencyKey?: string;
  // The caller's `tool_context` — an orchestration run's bag on a `tool`/`poll`
  // node, the parent call's on a pipeline step. It resolves `{{context:}}` in
  // this tool's headers and presets, and is forwarded as context headers.
  toolContext?: Record<string, string>;
  // Who the call's executions are metered against; a pipeline's steps inherit it.
  attribution: ToolCallAttribution;
  signedOff?: SignedOffCall;
};

/**
 * One pipeline step: an inline definition runs in the pipeline's project, a
 * `tool_id` resolves in the pipeline's reach. Either is still the pipeline
 * caller's work, metered and gated where the pipeline was called.
 */
const callPipelineStep = (args: {
  step: Parameters<PipelineStepCaller>[0];
  pipeline: CallResolvedToolArgs;
  attribution: ToolCallAttribution;
  // `runResolvedTool`, passed in so the two need no forward reference.
  callResolved: (args: CallResolvedToolArgs) => Promise<unknown>;
}): Promise<unknown> => {
  const { step, pipeline, attribution } = args;
  // A step is the pipeline's own work, so it inherits the context the pipeline
  // was called with — the same rule a nested orchestration run follows.
  const shared = {
    action: step.action,
    input: step.input,
    authHeader: pipeline.authHeader,
    remainingDepth: step.remainingDepth,
    toolContext: pipeline.toolContext,
    attribution,
  };
  if (step.tool) {
    assertEphemeralTypeSupported(step.tool);
    return args.callResolved({
      tool: step.tool,
      toolProjectId: pipeline.toolProjectId,
      callerProjectId: pipeline.callerProjectId,
      // An inline step definition has no Tool row and so no tool-scoped
      // guardrail of its own, but the project's still governs it.
      guardrails: 'apply',
      ...shared,
    });
  }
  return callTool({
    projectId: pipeline.toolProjectId,
    reach: 'shares',
    callerProjectId: pipeline.callerProjectId,
    id: step.toolId as string,
    // A step is a call of that tool like any other: its own guardrails govern
    // it here exactly as they would a direct call.
    guardrails: 'apply',
    ...shared,
  });
};

/**
 * The presets a call is gated on and sent, resolved once so every dispatch
 * below (and the pipeline's own merge) sees the same values — they reach
 * `callHttpTool`/`callMcpTool` already merged, and are not resolved a second
 * time there. An `mcp` action takes only the presets its schema declares, so
 * its schema is read here, before the gate.
 */
const resolveCallPresets = async (args: {
  call: CallResolvedToolArgs;
  type: string;
  meter: ToolExecutionMeter;
}): Promise<{
  presetParameters: Record<string, unknown> | null;
  mcp: PreparedMcpCall | null;
}> => {
  const { call } = args;
  // Resolved with no bag: a token the proposal could not resolve fails with
  // `MISSING_TOOL_CONTEXT_KEY` rather than taking the resolver's value.
  const resolvedPresets = call.signedOff
    ? resolvePresetParametersForCall({
        presetParameters: frozenPresets({
          presetParameters: call.tool.presetParameters,
          frozenArguments: call.signedOff.frozenArguments,
        }),
        toolName: call.tool.name,
        schema: call.tool.parameters,
      })
    : resolvePresetParametersForCall({
        presetParameters: call.tool.presetParameters,
        toolContext: call.toolContext,
        toolName: call.tool.name,
        schema: call.tool.parameters,
      });
  if (args.type !== 'mcp') {
    return { presetParameters: resolvedPresets, mcp: null };
  }
  const mcp = await prepareMcpCall({
    tool: call.tool,
    action: call.action,
    input: mergePresetParameters({
      presetParameters: resolvedPresets,
      input: call.input,
    }),
    meter: args.meter,
    toolContext: call.toolContext,
  });
  return {
    presetParameters: presetsDeclaredBy({
      presetParameters: resolvedPresets,
      schema: mcp.schema,
    }),
    mcp,
  };
};

const runResolvedTool = async (
  args: CallResolvedToolArgs
): Promise<unknown> => {
  const type = args.tool.type ?? 'http';
  const meter = {
    projectId: args.toolProjectId,
    callerProjectId: args.callerProjectId,
    toolId: args.toolPublicId ?? null,
    workId: readRunTokenWork(args.authHeader),
    attribution: args.attribution,
  };
  const { presetParameters, mcp } = await resolveCallPresets({
    call: args,
    type,
    meter,
  });

  // Before any dispatch and before the pipeline runner, so a gated pipeline is
  // refused whole rather than after its first step has already run.
  const gate = await adjudicate({ args, presetParameters });
  const { input } = gate;
  const attribution = withReleasingGuardrails({
    attribution: args.attribution,
    guardrailIds: gate.guardrailIds,
  });

  const mergedInput = mergePresetParameters({
    presetParameters,
    input,
  });

  if (type === 'pipeline') {
    // In-process: metered as an execution of its own, beside each step's, once
    // it starts running — a pipeline its own config or depth refuses never ran.
    return meterToolExecution({
      meter: { ...meter, attribution },
      send: async (markSent) => {
        const rawResult = await runPipeline({
          onStart: () => {
            markSent();
          },
          pipeline: args.tool.pipeline,
          presetParameters,
          input,
          remainingDepth: args.remainingDepth,
          callStep: (step: Parameters<PipelineStepCaller>[0]) => {
            return callPipelineStep({
              step,
              pipeline: args,
              attribution,
              callResolved: runResolvedTool,
            });
          },
        });
        return applyToolOutputMapping({
          outputMapping:
            (args.tool.outputMapping as Record<string, unknown> | null) ?? null,
          rawResult,
          input: mergedInput,
        });
      },
    });
  }

  const rawResult = mcp
    ? await callMcpTool({
        prepared: mcp,
        mergedInput,
        meter: { ...meter, attribution },
      })
    : await dispatchDirectTool({
        ...args,
        type,
        mergedInput,
        meter: { ...meter, attribution },
      });

  return applyToolOutputMapping({
    outputMapping:
      (args.tool.outputMapping as Record<string, unknown> | null) ?? null,
    rawResult,
    input: mergedInput,
    action: actionOfType({ type, action: args.action }),
  });
};

export const callResolvedTool = async (
  args: CallResolvedToolArgs
): Promise<unknown> => {
  const crossProject = isCrossProject(args);
  if (crossProject && args.toolPublicId) {
    await admitSharedCall({
      resourceType: 'tool',
      resourceId: args.toolPublicId,
      projectId: args.callerProjectId,
    });
  }
  const caller = crossProject
    ? await db.Project.findByPk(args.callerProjectId, {
        attributes: ['publicId'],
      })
    : null;
  return runResolvedTool({
    ...args,
    toolContext: pinCallingProject({
      toolContext: args.toolContext,
      callingProjectPublicId: caller?.publicId ?? null,
    }),
  });
};
