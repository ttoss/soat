import { DomainError } from '../errors';
import {
  MAX_BRANCHES,
  MAX_ROUNDS,
  MAX_STEPS,
  MAX_TOTAL_COMPLETIONS,
} from './reasoning';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const invalid = (message: string): never => {
  throw new DomainError('INVALID_REASONING_CONFIG', message);
};

const isStringOrUndefined = (value: unknown): boolean => {
  return value === undefined || typeof value === 'string';
};

const isNumberOrUndefined = (value: unknown): boolean => {
  return value === undefined || typeof value === 'number';
};

/** Matches the same template tokens `resolveTemplate` resolves at runtime. */
const TEMPLATE_TOKEN = /\{([\w.]+)\}/g;

const TRANSCRIPT_TOKEN = /\{transcript\}/;

/** Fields removed by the branches/rounds normalization — rejected explicitly. */
const REMOVED_STEP_FIELDS = ['kind', 'count', 'perspectives'] as const;

type StepShape = { branchCount: number; hasTranscript: boolean };

const stepBranches = (step: Record<string, unknown>): unknown[] | undefined => {
  return Array.isArray(step.branches) && step.branches.length > 0
    ? step.branches
    : undefined;
};

/** The prompt each branch effectively runs with: its own, or the step's as fallback. */
const effectivePrompts = (step: Record<string, unknown>): unknown[] => {
  const branches = stepBranches(step);
  if (!branches) return [step.prompt];
  return branches.map((branch) => {
    return isPlainObject(branch) && typeof branch.prompt === 'string'
      ? branch.prompt
      : step.prompt;
  });
};

const stepHasTranscript = (step: Record<string, unknown>): boolean => {
  return effectivePrompts(step).some((prompt) => {
    return typeof prompt === 'string' && TRANSCRIPT_TOKEN.test(prompt);
  });
};

const stepBranchCount = (step: Record<string, unknown>): number => {
  return stepBranches(step)?.length ?? 1;
};

type StepRef = { name: string; isLast: boolean };

/**
 * Extracts the step references via `{steps.<name>}` / `{steps.<name>.last}` in
 * a prompt. Mirrors the runtime token grammar so validation and resolution
 * stay in lockstep. `.last` is the only supported suffix — anything else is
 * treated as (and rejected as) an unknown step name, since names may not
 * contain '.'.
 */
const extractStepRefs = (prompt: unknown): StepRef[] => {
  if (typeof prompt !== 'string') return [];
  const refs: StepRef[] = [];
  for (const match of prompt.matchAll(TEMPLATE_TOKEN)) {
    const token = match[1];
    if (!token.startsWith('steps.')) continue;
    const rest = token.slice('steps.'.length);
    const lastSuffix = /^(.+)\.last$/.exec(rest);
    refs.push(
      lastSuffix
        ? { name: lastSuffix[1], isLast: true }
        : { name: rest, isLast: false }
    );
  }
  return refs;
};

/**
 * Rejects a step whose prompt (or any of its branch prompts) references a
 * `{steps.<name>}` that is not an earlier, declared step — a typo or forward
 * reference would otherwise silently resolve to an empty string at runtime.
 * Also rejects `{steps.<name>.last}` against an independent multi-branch step:
 * the last turn there is an arbitrary sample, not a converged result.
 */
const checkStepRef = (args: {
  ref: StepRef;
  index: number;
  priorNames: Set<string>;
  shapes: Map<string, StepShape>;
}): void => {
  const { ref } = args;
  if (!args.priorNames.has(ref.name)) {
    invalid(
      `reasoning.steps[${args.index}] references unknown step '${ref.name}'; a {steps.<name>} token must name an earlier step.`
    );
  }
  if (!ref.isLast) return;
  const shape = args.shapes.get(ref.name);
  if (shape && shape.branchCount > 1 && !shape.hasTranscript) {
    invalid(
      `reasoning.steps[${args.index}] references {steps.${ref.name}.last}, but '${ref.name}' is an independent multi-branch step; .last is only meaningful on a single-branch or {transcript}-shared step.`
    );
  }
};

const validateStepReferences = (args: {
  step: Record<string, unknown>;
  index: number;
  priorNames: Set<string>;
  shapes: Map<string, StepShape>;
}): void => {
  const prompts: unknown[] = [args.step.prompt];
  if (Array.isArray(args.step.branches)) {
    for (const branch of args.step.branches) {
      if (isPlainObject(branch)) prompts.push(branch.prompt);
    }
  }
  for (const prompt of prompts) {
    for (const ref of extractStepRefs(prompt)) {
      checkStepRef({
        ref,
        index: args.index,
        priorNames: args.priorNames,
        shapes: args.shapes,
      });
    }
  }
};

const rejectRemovedFields = (
  step: Record<string, unknown>,
  index: number
): void => {
  for (const field of REMOVED_STEP_FIELDS) {
    if (step[field] !== undefined) {
      invalid(
        `reasoning.steps[${index}].${field} was removed; express it with 'branches' instead.`
      );
    }
  }
};

const validateBranchEntry = (args: { branch: unknown; path: string }): void => {
  const { branch, path } = args;
  if (!isPlainObject(branch)) {
    invalid(`${path} must be an object.`);
    return;
  }
  if (!isStringOrUndefined(branch.name)) {
    invalid(`${path}.name must be a string.`);
  }
  if (!isStringOrUndefined(branch.prompt)) {
    invalid(`${path}.prompt must be a string.`);
  }
  if (!isStringOrUndefined(branch.aiProviderId)) {
    invalid(`${path}.aiProviderId must be a string.`);
  }
  if (!isStringOrUndefined(branch.model)) {
    invalid(`${path}.model must be a string.`);
  }
  if (!isNumberOrUndefined(branch.temperature)) {
    invalid(`${path}.temperature must be a number.`);
  }
};

/**
 * Validates the `branches` of a step. Only the array length and per-branch
 * field shape are bounded here; this enforces the shape the runtime relies on.
 */
const validateBranches = (
  step: Record<string, unknown>,
  index: number
): void => {
  if (step.branches === undefined) return;
  if (!Array.isArray(step.branches)) {
    invalid(`reasoning.steps[${index}].branches must be an array.`);
    return;
  }
  if (step.branches.length < 1 || step.branches.length > MAX_BRANCHES) {
    invalid(
      `reasoning.steps[${index}].branches must have 1–${MAX_BRANCHES} entries.`
    );
  }
  for (const [entryIndex, branch] of step.branches.entries()) {
    validateBranchEntry({
      branch,
      path: `reasoning.steps[${index}].branches[${entryIndex}]`,
    });
  }
};

const resolveRounds = (step: Record<string, unknown>, index: number) => {
  const rounds = step.rounds === undefined ? 1 : step.rounds;
  if (typeof rounds !== 'number' || rounds < 1 || rounds > MAX_ROUNDS) {
    invalid(
      `reasoning.steps[${index}].rounds must be between 1 and ${MAX_ROUNDS}.`
    );
  }
  if ((rounds as number) > 1 && !stepHasTranscript(step)) {
    invalid(
      `reasoning.steps[${index}] has rounds > 1 but no prompt references {transcript}; without a shared transcript, rounds produce redundant independent samples.`
    );
  }
  return rounds as number;
};

const validateHaltIfEquals = (
  step: Record<string, unknown>,
  index: number
): void => {
  if (step.haltIfEquals === undefined) return;
  if (typeof step.haltIfEquals !== 'string') {
    invalid(`reasoning.steps[${index}].haltIfEquals must be a string.`);
  }
  if (stepBranchCount(step) > 1) {
    invalid(
      `reasoning.steps[${index}].haltIfEquals is only valid on a single-branch step.`
    );
  }
};

const validateStepContent = (
  step: Record<string, unknown>,
  index: number
): void => {
  const branches = stepBranches(step);
  const everyBranchHasPrompt =
    branches !== undefined &&
    branches.every((branch) => {
      return (
        isPlainObject(branch) &&
        typeof branch.prompt === 'string' &&
        branch.prompt.trim().length > 0
      );
    });
  if (!everyBranchHasPrompt) {
    if (typeof step.prompt !== 'string' || step.prompt.trim().length === 0) {
      invalid(
        `reasoning.steps[${index}].prompt is required unless every branch supplies its own.`
      );
    }
  } else if (step.prompt !== undefined && typeof step.prompt !== 'string') {
    invalid(`reasoning.steps[${index}].prompt must be a string.`);
  }
  if (!isStringOrUndefined(step.aiProviderId)) {
    invalid(`reasoning.steps[${index}].aiProviderId must be a string.`);
  }
  if (!isStringOrUndefined(step.model)) {
    invalid(`reasoning.steps[${index}].model must be a string.`);
  }
  if (!isNumberOrUndefined(step.temperature)) {
    invalid(`reasoning.steps[${index}].temperature must be a number.`);
  }
};

const validateStepIdentity = (args: {
  step: Record<string, unknown>;
  index: number;
  names: Set<string>;
}): void => {
  const { step, index, names } = args;
  if (typeof step.name !== 'string' || step.name.trim().length === 0) {
    invalid(`reasoning.steps[${index}].name is required.`);
  }
  const name = step.name as string;
  if (name.includes('.')) {
    invalid(
      `reasoning.steps[${index}].name '${name}' must not contain '.' (reserved for the {steps.<name>.last} suffix).`
    );
  }
  if (names.has(name)) {
    invalid(`reasoning.steps[${index}].name '${name}' is duplicated.`);
  }
  names.add(name);
};

const validateStep = (args: {
  step: unknown;
  index: number;
  names: Set<string>;
}): number => {
  if (!isPlainObject(args.step)) {
    invalid(`reasoning.steps[${args.index}] must be an object.`);
    return 1;
  }
  const step = args.step;
  rejectRemovedFields(step, args.index);
  validateStepIdentity({ step, index: args.index, names: args.names });
  validateStepContent(step, args.index);
  validateBranches(step, args.index);
  validateHaltIfEquals(step, args.index);
  const rounds = resolveRounds(step, args.index);
  return stepBranchCount(step) * rounds;
};

const validatePipelineSteps = (steps: unknown): void => {
  if (!Array.isArray(steps) || steps.length === 0) {
    invalid('reasoning.steps is required and must be a non-empty array.');
    return;
  }
  if (steps.length > MAX_STEPS) {
    invalid(`reasoning.steps cannot exceed ${MAX_STEPS} steps.`);
  }
  const names = new Set<string>();
  const shapes = new Map<string, StepShape>();
  let totalCompletions = 0;
  for (const [index, step] of steps.entries()) {
    // `names` holds only earlier steps here — validateStep adds this step's
    // name — so reference checking against it enforces earlier-only ordering.
    if (isPlainObject(step)) {
      validateStepReferences({ step, index, priorNames: names, shapes });
    }
    totalCompletions += validateStep({ step, index, names });
    if (isPlainObject(step) && typeof step.name === 'string') {
      shapes.set(step.name, {
        branchCount: stepBranchCount(step),
        hasTranscript: stepHasTranscript(step),
      });
    }
  }
  if (totalCompletions > MAX_TOTAL_COMPLETIONS) {
    invalid(
      `reasoning pipeline exceeds ${MAX_TOTAL_COMPLETIONS} total completions.`
    );
  }
};

/**
 * Validates a reasoning config at every write choke point (agent create/update
 * and the per-generate override). Throws `INVALID_REASONING_CONFIG` on any
 * structural problem. A null/undefined config or an effort-only config is
 * always valid.
 */
export const validateReasoningConfig = (config: unknown): void => {
  if (config === null || config === undefined) return;
  if (!isPlainObject(config)) {
    invalid('reasoning must be an object.');
    return;
  }
  const mode = config.mode;
  if (mode !== undefined && mode !== 'none' && mode !== 'pipeline') {
    invalid(`reasoning.mode '${String(mode)}' is invalid.`);
  }
  if (mode !== 'pipeline') return;
  validatePipelineSteps(config.steps);
};
