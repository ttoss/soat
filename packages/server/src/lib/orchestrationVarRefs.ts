/**
 * Recursively collects every `var` reference path used in a JSON Logic
 * expression. `applyInputMapping` evaluates each mapping value against the run
 * state, so `{ var: 'foo' }` reads `state.foo`. Returns the raw path strings
 * (e.g. `'foo'`, `'foo.bar'`). Numeric indices and the empty path (whole
 * state) are ignored — they cannot be statically resolved to a single key.
 */
export const collectVarRefs = (expr: unknown): string[] => {
  if (Array.isArray(expr)) {
    return expr.flatMap(collectVarRefs);
  }
  if (expr === null || typeof expr !== 'object') return [];

  const refs: string[] = [];
  for (const [operator, operand] of Object.entries(
    expr as Record<string, unknown>
  )) {
    if (operator === 'var') {
      const path = Array.isArray(operand) ? operand[0] : operand;
      if (typeof path === 'string' && path.length > 0) refs.push(path);
      continue;
    }
    refs.push(...collectVarRefs(operand));
  }
  return refs;
};
