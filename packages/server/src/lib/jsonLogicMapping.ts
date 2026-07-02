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
 * Structural check matching the legacy `json-logic-js` `is_logic`, tightened
 * with an operator check: a JSON Logic expression is a non-null, non-array
 * object with exactly one key, and that key must name a registered engine
 * operator (`var`, `cat`, `if`, `preserve`, ...). This disambiguates plain
 * data shaped like `{ title: ... }` from a real expression, which the operator
 * name alone can't tell apart at a glance. Everything else (primitives,
 * arrays, multi-key objects, single-key objects with a non-operator key) is
 * treated as a literal and recursed into instead of evaluated.
 */
export const isLogic = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] in engine.methods;
};

/**
 * Evaluates a value against `context`, resolving JSON Logic expressions at any
 * nesting depth: `{ var: 'key' }` reads `context.key` (a missing path resolves
 * to `null`); `{ cat: [...] }`, `{ '>': [...] }`, `{ map: [...] }`, etc.
 * compute derived values. A matched expression's *result* is returned as-is
 * (never re-walked), which is what lets `{ preserve: { var: 'x' } }` hand back
 * the literal `{ var: 'x' }` untouched — the escape hatch for passing a
 * genuine JSON-Logic-shaped object through as data. Arrays and plain objects
 * that are not themselves an expression are recursed into so nested markers
 * (e.g. `data.title` inside `{ data: { title: { var: ... } } }`) resolve too;
 * every other value is returned unchanged.
 */
export const evaluateLogic = (value: unknown, context: unknown): unknown => {
  if (isLogic(value)) {
    return engine.run(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      return evaluateLogic(item, context);
    });
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = evaluateLogic(item, context);
    }
    return result;
  }
  return value;
};

/**
 * Resolves every value of a mapping object against `context` via
 * {@link evaluateLogic}, recursively — JSON Logic expressions are evaluated at
 * any nesting depth, not just at the mapping's top level.
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
