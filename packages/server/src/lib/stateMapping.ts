import jsonLogic from 'json-logic-js';

/**
 * Shared JSON Logic state-mapping helpers used by both the orchestration engine
 * (`orchestrationNodeExecutors.ts`) and the pipeline tool executor
 * (`pipelineTools.ts`). Kept dependency-free so it can be imported by `tools.ts`
 * without pulling in the heavier orchestration import graph.
 */

export const writeToState = (
  path: string,
  value: unknown,
  state: Record<string, unknown>
): void => {
  if (!path.startsWith('state.')) return;
  const fieldName = path.slice('state.'.length);
  state[fieldName] = value;
};

/**
 * Resolves each inputMapping value against the run state.
 *
 * Every value is interpreted as JSON Logic (https://jsonlogic.com), the same
 * evaluator used by transform and condition nodes. Single-key objects are
 * treated as expressions and evaluated against state — `{ var: 'key' }` reads
 * `state.key`, `{ cat: [...] }`, `{ '>': [...] }`, etc. compute derived values.
 * Every other value (string, number, boolean, array, multi-key object) is a
 * literal and is passed through as-is.
 */
export const applyInputMapping = (
  inputMapping: Record<string, unknown> | undefined,
  state: Record<string, unknown>
): Record<string, unknown> => {
  if (!inputMapping) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputMapping)) {
    result[key] = jsonLogic.is_logic(value)
      ? jsonLogic.apply(value, state)
      : value;
  }
  return result;
};

export const applyOutputMapping = (
  outputMapping: Record<string, string> | undefined,
  artifact: Record<string, unknown>,
  state: Record<string, unknown>
): void => {
  if (!outputMapping) return;
  for (const [artifactKey, statePath] of Object.entries(outputMapping)) {
    writeToState(statePath, artifact[artifactKey], state);
  }
};
