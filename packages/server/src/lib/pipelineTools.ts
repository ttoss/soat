import { db } from '../db';
import { DomainError } from '../errors';
import { applyInputMapping } from './jsonLogicMapping';

// ── Types ───────────────────────────────────────────────────────────────────

export type PipelineStep = {
  id: string;
  toolId: string;
  action?: string;
  input?: Record<string, unknown>;
};

export type PipelineConfig = {
  steps: PipelineStep[];
  output?: Record<string, unknown>;
};

/**
 * Executes a single resolved tool call. Injected by the caller (tools.ts) so the
 * pipeline runner reuses `callTool` without a circular import.
 */
export type PipelineStepCaller = (call: {
  toolId: string;
  action?: string;
  input: Record<string, unknown>;
  remainingDepth: number;
}) => Promise<unknown>;

const DEFAULT_PIPELINE_DEPTH = 5;
const STEP_ID_RE = /^[A-Za-z0-9_]+$/;

// ── Helpers ──────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseOptionalString = (
  value: unknown,
  errorMessage: string
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new DomainError('PIPELINE_INVALID_STEP', errorMessage);
};

const parseOptionalRecord = (
  value: unknown,
  errorMessage: string
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (isRecord(value)) return value;
  throw new DomainError('PIPELINE_INVALID_STEP', errorMessage);
};

const addVarStepRef = (
  varObject: Record<string, unknown>,
  refs: Set<string>
): void => {
  const raw = varObject['var'];
  const path = Array.isArray(raw) ? raw[0] : raw;
  if (typeof path !== 'string') return;
  const parts = path.split('.');
  if (parts[0] === 'steps' && parts[1]) refs.add(parts[1]);
};

/**
 * Collects the step ids referenced by `{ var: 'steps.<id>...' }` expressions
 * anywhere inside a JSON Logic value.
 */
const collectStepRefs = (value: unknown, refs: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectStepRefs(item, refs);
    return;
  }
  if (!isRecord(value)) return;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'var') {
    addVarStepRef(value, refs);
    return;
  }
  for (const key of keys) collectStepRefs(value[key], refs);
};

/**
 * Enforces the forward-reference ban: a step may only read `steps.<id>` of a
 * step that appears earlier in the sequence (i.e. already in `seen`).
 */
const assertStepRefsResolved = (
  id: string,
  input: Record<string, unknown> | undefined,
  seen: Set<string>
): void => {
  const refs = new Set<string>();
  collectStepRefs(input, refs);
  for (const ref of refs) {
    if (!seen.has(ref)) {
      throw new DomainError(
        'PIPELINE_INVALID_STEP',
        `Pipeline step '${id}' references step '${ref}', which is not an earlier step.`
      );
    }
  }
};

const parseStep = (
  rawStep: unknown,
  index: number,
  seen: Set<string>
): PipelineStep => {
  if (!isRecord(rawStep)) {
    throw new DomainError(
      'PIPELINE_INVALID_STEP',
      `Pipeline step at index ${index} must be an object.`
    );
  }
  const id = rawStep['id'];
  if (typeof id !== 'string' || !STEP_ID_RE.test(id)) {
    throw new DomainError(
      'PIPELINE_INVALID_STEP',
      `Pipeline step at index ${index} must have an id matching ${String(STEP_ID_RE)}.`
    );
  }
  if (seen.has(id)) {
    throw new DomainError(
      'PIPELINE_INVALID_STEP',
      `Duplicate pipeline step id '${id}'.`
    );
  }
  // Accept both `toolId` (REST body, case-transformed by middleware) and
  // `tool_id` (formation templates, stored verbatim and kept snake_case).
  const toolId = rawStep['toolId'] ?? rawStep['tool_id'];
  if (typeof toolId !== 'string' || toolId.length === 0) {
    throw new DomainError(
      'PIPELINE_INVALID_STEP',
      `Pipeline step '${id}' must reference a tool_id.`
    );
  }
  const action = parseOptionalString(
    rawStep['action'],
    `Pipeline step '${id}' action must be a string.`
  );
  const input = parseOptionalRecord(
    rawStep['input'],
    `Pipeline step '${id}' input must be an object.`
  );
  assertStepRefsResolved(id, input, seen);
  return { id, toolId, action, input };
};

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates and normalizes a pipeline tool's `pipeline` config. Enforces the
 * invariants that make a pipeline a deterministic linear sequence: a non-empty
 * list of steps, unique step ids, a tool reference per step, and a forward-
 * reference ban (a step may only read `steps.<id>` of an earlier step).
 * Throws `PIPELINE_INVALID_STEP` on any violation.
 */
export const validatePipelineConfig = (pipeline: unknown): PipelineConfig => {
  if (!isRecord(pipeline)) {
    throw new DomainError(
      'PIPELINE_INVALID_STEP',
      'A pipeline tool requires a `pipeline` object.'
    );
  }
  const rawSteps = pipeline['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new DomainError(
      'PIPELINE_INVALID_STEP',
      'Pipeline `steps` must be a non-empty array.'
    );
  }

  const seen = new Set<string>();
  const steps: PipelineStep[] = [];
  for (let index = 0; index < rawSteps.length; index += 1) {
    const step = parseStep(rawSteps[index], index, seen);
    steps.push(step);
    seen.add(step.id);
  }

  const output = parseOptionalRecord(
    pipeline['output'],
    'Pipeline `output` must be an object.'
  );

  return { steps, output };
};

/**
 * Verifies every step references a tool that exists in scope and is not a
 * `client` tool (which cannot run server-side). Throws `PIPELINE_INVALID_STEP`.
 */
export const assertPipelineStepToolsValid = async (args: {
  steps: PipelineStep[];
  projectIds?: number[];
}): Promise<void> => {
  for (const step of args.steps) {
    const where: Record<string, unknown> = { publicId: step.toolId };
    if (args.projectIds !== undefined) {
      where['projectId'] = args.projectIds;
    }
    const stepTool = await db.Tool.findOne({ where });
    if (!stepTool) {
      throw new DomainError(
        'PIPELINE_INVALID_STEP',
        `Pipeline step '${step.id}' references unknown tool '${step.toolId}'.`,
        { step_id: step.id, tool_id: step.toolId }
      );
    }
    if (stepTool.type === 'client') {
      throw new DomainError(
        'PIPELINE_INVALID_STEP',
        `Pipeline step '${step.id}' references client tool '${step.toolId}', which cannot run server-side.`,
        { step_id: step.id, tool_id: step.toolId }
      );
    }
  }
};

// ── Execution ─────────────────────────────────────────────────────────────────

const executeStep = async (args: {
  step: PipelineStep;
  context: Record<string, unknown>;
  remainingDepth: number;
  callStep: PipelineStepCaller;
}): Promise<unknown> => {
  const { step } = args;
  try {
    const input = applyInputMapping(step.input, args.context);
    return await args.callStep({
      toolId: step.toolId,
      action: step.action,
      input,
      remainingDepth: args.remainingDepth - 1,
    });
  } catch (error) {
    // Already-wrapped pipeline failures propagate as-is (preserve inner step).
    if (
      error instanceof DomainError &&
      (error.code === 'PIPELINE_DEPTH_EXCEEDED' ||
        error.code === 'PIPELINE_STEP_FAILED')
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DomainError(
      'PIPELINE_STEP_FAILED',
      `Pipeline step '${step.id}' failed: ${message}`,
      { step_id: step.id }
    );
  }
};

/**
 * Runs a pipeline tool deterministically: each step's input is built from the
 * pipeline input and earlier step outputs via JSON Logic, then executed through
 * the injected `callStep`. Each step's raw output is captured under
 * `steps.<id>`. Returns the resolved `output` mapping, or the last step's output
 * when no `output` is configured.
 */
export const runPipeline = async (args: {
  pipeline: unknown;
  presetParameters?: object | null;
  input?: Record<string, unknown>;
  remainingDepth?: number;
  callStep: PipelineStepCaller;
}): Promise<unknown> => {
  const config = validatePipelineConfig(args.pipeline);
  const remainingDepth = args.remainingDepth ?? DEFAULT_PIPELINE_DEPTH;
  if (remainingDepth <= 0) {
    throw new DomainError(
      'PIPELINE_DEPTH_EXCEEDED',
      'Pipeline exceeded the maximum nested execution depth.'
    );
  }

  const stepOutputs: Record<string, unknown> = {};
  const context: Record<string, unknown> = {
    input: { ...(args.presetParameters ?? {}), ...(args.input ?? {}) },
    steps: stepOutputs,
  };

  let lastOutput: unknown;
  for (const step of config.steps) {
    lastOutput = await executeStep({
      step,
      context,
      remainingDepth,
      callStep: args.callStep,
    });
    stepOutputs[step.id] = lastOutput;
  }

  return config.output ? applyInputMapping(config.output, context) : lastOutput;
};
