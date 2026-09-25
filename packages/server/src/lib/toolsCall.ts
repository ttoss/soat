import { DomainError } from '../errors';
import { applyToolOutputMapping } from './jsonLogicMapping';
import type { PipelineStepCaller } from './pipelineTools';
import { runPipeline } from './pipelineTools';
import {
  assertToolCallAllowed,
  type ToolCallGuardrailMode,
} from './toolCallGuardrail';
import { mergePresetParameters } from './toolPresetParameters';
import { callTool } from './tools';
import { dispatchDirectTool } from './toolsCallDispatch';
import { resolvePresetParametersForCall } from './toolTemplates';
import {
  type ToolCallAttribution,
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
 * Runs the guardrail gate unless a gate upstream already classified this call,
 * and answers with the arguments dispatch should carry.
 */
const adjudicate = async (gateArgs: {
  args: {
    tool: CallableToolDefinition;
    toolProjectId: number;
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
    toolGuardrailIds: args.toolGuardrailIds,
    action: args.action,
    input: args.input ?? {},
    presetParameters,
    projectId: args.toolProjectId,
    authHeader: args.authHeader,
  });
};

type CallResolvedToolArgs = {
  tool: CallableToolDefinition;
  toolProjectId: number;
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
  projectIds?: number[];
  idempotencyKey?: string;
  // The caller's `tool_context` — an orchestration run's bag on a `tool`/`poll`
  // node, the parent call's on a pipeline step. It resolves `{{context:}}` in
  // this tool's headers and presets, and is forwarded as context headers.
  toolContext?: Record<string, string>;
  // Who the call's executions are metered against; a pipeline's steps inherit it.
  attribution: ToolCallAttribution;
};

export const callResolvedTool = async (
  args: CallResolvedToolArgs
): Promise<unknown> => {
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
    const rawResult = await runPipeline({
      pipeline: args.tool.pipeline,
      presetParameters,
      input,
      remainingDepth: args.remainingDepth,
      callStep: (step: Parameters<PipelineStepCaller>[0]) => {
        if (step.tool) {
          assertEphemeralTypeSupported(step.tool);
          return callResolvedTool({
            tool: step.tool,
            toolProjectId: args.toolProjectId,
            // An inline step definition has no Tool row and so no tool-scoped
            // guardrail of its own, but the project's still governs it.
            guardrails: 'apply',
            action: step.action,
            input: step.input,
            authHeader: args.authHeader,
            remainingDepth: step.remainingDepth,
            // A step is the pipeline's own work, so it inherits the context the
            // pipeline was called with — the same rule a nested orchestration
            // run follows.
            toolContext: args.toolContext,
            attribution,
          });
        }
        return callTool({
          projectIds: args.projectIds,
          id: step.toolId as string,
          // A step is a call of that tool like any other: its own guardrails
          // govern it here exactly as they would a direct call.
          guardrails: 'apply',
          action: step.action,
          input: step.input,
          authHeader: args.authHeader,
          remainingDepth: step.remainingDepth,
          toolContext: args.toolContext,
          attribution,
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
    meter: {
      projectId: args.toolProjectId,
      toolId: args.toolPublicId ?? null,
      attribution,
    },
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
  guardrails: ToolCallGuardrailMode;
  action?: string;
  input?: Record<string, unknown>;
  authHeader?: string;
  remainingDepth?: number;
  toolContext?: Record<string, string>;
  attribution: ToolCallAttribution;
}): Promise<unknown> => {
  assertEphemeralTypeSupported(args.definition);
  return callResolvedTool({
    tool: args.definition,
    toolProjectId: args.projectId,
    guardrails: args.guardrails,
    action: args.action,
    input: args.input,
    authHeader: args.authHeader,
    remainingDepth: args.remainingDepth,
    toolContext: args.toolContext,
    attribution: args.attribution,
  });
};
