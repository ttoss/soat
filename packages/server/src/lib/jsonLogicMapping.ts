import createDebug from 'debug';
import { LogicEngine } from 'json-logic-engine';

import { DomainError } from '../errors';

const log = createDebug('soat:jsonLogicMapping');

/**
 * Shared synchronous JSON Logic evaluator (https://jsonlogic.com).
 *
 * A single engine instance is reused across every mapping evaluation —
 * orchestration nodes and pipeline tool steps alike — so JSON Logic behaves
 * identically everywhere in the server.
 */
const engine = new LogicEngine();

const readNumber = (args: { operator: string; value: unknown }): number => {
  const number =
    typeof args.value === 'string' && args.value.trim() !== ''
      ? Number(args.value)
      : args.value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new Error(
      `${args.operator} needs a number, got ${JSON.stringify(args.value)}.`
    );
  }
  return number;
};

/**
 * `{ "<operator>": [value, digits] }` or `{ "<operator>": value }`. Scales by
 * exponent notation rather than multiplying, so `1.005` rounds to `1.01`;
 * `round` takes a half away from zero.
 */
const toDigits = (operator: string, apply: (value: number) => number) => {
  return (args: unknown): number => {
    const [rawValue, rawDigits = 0] = Array.isArray(args) ? args : [args];
    const value = readNumber({ operator, value: rawValue });
    const digits = readNumber({ operator, value: rawDigits });
    if (!Number.isInteger(digits) || Math.abs(digits) > 15) {
      throw new Error(`${operator} digits must be an integer from -15 to 15.`);
    }
    const scaled = apply(Number(`${value}e${digits}`));
    return Number(`${scaled}e${-digits}`) + 0;
  };
};

engine.addMethod(
  'round',
  toDigits('round', (value) => {
    return Math.sign(value) * Math.round(Math.abs(value));
  }),
  { deterministic: true }
);
engine.addMethod('floor', toDigits('floor', Math.floor), {
  deterministic: true,
});
engine.addMethod('ceil', toDigits('ceil', Math.ceil), { deterministic: true });

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
 * What an expression threw, as text. The engine throws bare objects — an
 * unknown operator is `{ type: 'Unknown Operator' }`, a `throw` is
 * `{ type: <value> }` — which `String()` would collapse to "[object Object]".
 */
const describeThrown = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // A circular value has no JSON form; its string form stands.
    }
  }
  return String(error);
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
    try {
      return engine.run(value, context);
    } catch (error) {
      throw new DomainError(
        'EXPRESSION_FAILED',
        describeThrown(error),
        undefined,
        { cause: error }
      );
    }
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

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** The first segment of every `var` path in `expression`, at any depth. */
const varRoots = (expression: unknown, roots: Set<string>): Set<string> => {
  if (Array.isArray(expression)) {
    for (const item of expression) varRoots(item, roots);
  } else if (isPlainObject(expression)) {
    for (const [key, value] of Object.entries(expression)) {
      const path = Array.isArray(value) ? value[0] : value;
      if (key === 'var' && typeof path === 'string') {
        roots.add(path.split('.')[0]);
      }
      varRoots(value, roots);
    }
  }
  return roots;
};

/**
 * The binding names in evaluation order: each after the bindings it reads.
 * Key order cannot decide it: a binding may read one written after it.
 */
const bindingOrder = (bindings: Record<string, unknown>): string[] => {
  const names = Object.keys(bindings);
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`let bindings read each other in a cycle at '${name}'.`);
    }
    state.set(name, 'visiting');
    for (const root of varRoots(bindings[name], new Set())) {
      if (root !== name && root in bindings) visit(root);
    }
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of names) {
    if (!BINDING_NAME.test(name)) {
      throw new Error(`let binding '${name}' must be a plain name.`);
    }
    visit(name);
  }
  return order;
};

/**
 * `{ "let": [{ "<name>": <expr>, ... }, <body>] }`: each binding is evaluated
 * over the context plus the bindings it reads, and the body over the context
 * with every binding on top, read as `{ "var": "<name>" }`.
 */
const evaluateLet = (args: unknown, context: unknown): unknown => {
  if (!Array.isArray(args) || args.length !== 2 || !isPlainObject(args[0])) {
    throw new Error('let takes [{ "<name>": <expression>, ... }, <body>].');
  }
  const [bindings, body] = args;
  let scope: Record<string, unknown> = isPlainObject(context)
    ? { ...context }
    : {};
  for (const name of bindingOrder(bindings)) {
    scope = { ...scope, [name]: evaluateLogic(bindings[name], scope) };
  }
  return evaluateLogic(body, scope);
};

engine.addMethod(
  'let',
  {
    lazy: true,
    method: (args: unknown, context: unknown) => {
      return evaluateLet(args, context);
    },
  },
  { deterministic: false }
);

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

/**
 * Like {@link applyInputMapping}, but for mappings that may themselves be a
 * single JSON Logic expression rather than an object of keyed expressions —
 * e.g. a pipeline `output: { "var": "steps.call.text" }` that should resolve
 * to a bare scalar. Checks `isLogic` on the mapping as a whole first via
 * {@link evaluateLogic}; falls back to the per-key object behavior otherwise.
 */
export const applyOutputMapping = (
  outputMapping: Record<string, unknown> | undefined,
  context: Record<string, unknown>
): unknown => {
  if (!outputMapping) return {};
  return evaluateLogic(outputMapping, context);
};

/**
 * True when `expr` is specifically a `{ var: <path> }` JSON Logic expression
 * — narrower than {@link isLogic}, which accepts any registered operator.
 * Used to tell "this key maps a var that came back empty" apart from "this
 * key is a literal `null`" (see {@link findNullVarMappings}).
 */
const isVarExpression = (
  expr: unknown
): expr is { var: string | unknown[] } => {
  return (
    typeof expr === 'object' &&
    expr !== null &&
    !Array.isArray(expr) &&
    Object.keys(expr).length === 1 &&
    'var' in expr
  );
};

/**
 * Scans an outputMapping's top-level `var` expressions for ones whose
 * evaluated result is `null`: a `var` path that resolves to nothing on an
 * otherwise-successful call is a loggable event, not a silent `null`. Only the mapping's declared keys (or a bare top-level
 * expression) are checked; a `var` nested deeper inside a key's value is out
 * of scope, same as `applyToolOutputMapping`'s own resolution depth.
 */
export const findNullVarMappings = (
  outputMapping: Record<string, unknown>,
  result: unknown
): Array<{ key: string; path: string | unknown[] }> => {
  if (isVarExpression(outputMapping)) {
    return result === null ? [{ key: '(root)', path: outputMapping.var }] : [];
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return [];
  }
  const resultRecord = result as Record<string, unknown>;
  const misses: Array<{ key: string; path: string | unknown[] }> = [];
  for (const [key, expr] of Object.entries(outputMapping)) {
    if (isVarExpression(expr) && resultRecord[key] === null) {
      misses.push({ key, path: expr.var });
    }
  }
  return misses;
};

/**
 * Reshapes a tool's raw result via its `outputMapping` (JSON Logic evaluated
 * over `{ output, input, action }`), e.g. `{ var: "output.text" }` extracts a
 * bare scalar field and `{ var: "input.title" }` echoes back a field of the
 * request that produced the response. `action` names the `mcp` or `builtin`
 * action that ran, `null` for a tool with none, so one mapping can reshape
 * each action its own way. When no mapping is configured, the raw result is
 * returned untouched — unlike {@link applyOutputMapping}, which defaults to
 * `{}`.
 */
export const applyToolOutputMapping = (args: {
  outputMapping: Record<string, unknown> | null | undefined;
  rawResult: unknown;
  input?: Record<string, unknown>;
  action?: string | null;
}): unknown => {
  const { outputMapping, rawResult } = args;
  if (!outputMapping) return rawResult;
  const result = evaluateLogic(outputMapping, {
    output: rawResult,
    input: args.input ?? {},
    action: args.action ?? null,
  });
  for (const miss of findNullVarMappings(outputMapping, result)) {
    log(
      'applyToolOutputMapping: var path resolved to null key=%s path=%o',
      miss.key,
      miss.path
    );
  }
  return result;
};

/**
 * The action an `output_mapping` reads as `action`: the action of an `mcp` or
 * `builtin` tool, `null` for a tool type that has none.
 */
export const actionOfType = (args: {
  type: string;
  action?: string | null;
}): string | null => {
  return args.type === 'mcp' || args.type === 'builtin'
    ? (args.action ?? null)
    : null;
};
