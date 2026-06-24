import { LogicEngine } from 'json-logic-engine';

/**
 * Shared synchronous JSON Logic evaluator (https://jsonlogic.com).
 *
 * A single engine instance is reused across every mapping evaluation —
 * orchestration nodes and pipeline tool steps alike — so JSON Logic behaves
 * identically everywhere in the server.
 */
const engine = new LogicEngine();

/**
 * Structural check matching the legacy `json-logic-js` `is_logic`: a JSON Logic
 * expression is a non-null, non-array object with exactly one key. Everything
 * else (primitives, arrays, multi-key objects) is treated as a literal.
 */
export const isLogic = (value: unknown): boolean => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1
  );
};

/**
 * Evaluates a single value: when it is a JSON Logic expression it is run
 * against `context`, otherwise it is returned unchanged. `{ var: 'key' }` reads
 * `context.key` (a missing path resolves to `null`); `{ cat: [...] }`,
 * `{ '>': [...] }`, `{ map: [...] }`, etc. compute derived values.
 */
export const evaluateLogic = (value: unknown, context: unknown): unknown => {
  if (!isLogic(value)) return value;
  const result: unknown = engine.run(value, context);
  return result;
};

/**
 * Resolves each value of a mapping object against `context`. Each value is
 * interpreted as JSON Logic via {@link evaluateLogic}: single-key objects are
 * evaluated; every other value (string, number, boolean, array, multi-key
 * object) is passed through as a literal.
 */
export const applyInputMapping = (
  inputMapping: Record<string, unknown> | undefined,
  context: Record<string, unknown>
): Record<string, unknown> => {
  if (!inputMapping) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputMapping)) {
    result[key] = evaluateLogic(value, context);
  }
  return result;
};
