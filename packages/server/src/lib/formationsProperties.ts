/**
 * The rules that govern a formation resource declaration's `properties` bag.
 *
 * Both live here once rather than per pipeline: restated, the key normalization
 * gets skipped by some modules, and a second merge/changed predicate with
 * different semantics lets `plan-formation` disagree with the apply it
 * previewed.
 *
 * Neither function takes, returns or inspects a field *name*: one rewrites only
 * an object's own keys via the shared shallow normalizer, the other moves whole
 * values (`.claude/rules/case-convention.md`).
 */

import { isDeepStrictEqual } from 'node:util';

import { isPlainObject } from './plainObject';
import { normalizePropertyKeys } from './resource-inputs/normalizers';

/**
 * Puts a resource declaration's top-level property keys into the snake_case the
 * OpenAPI schemas, the modules' `read()` output, and the persisted
 * `lastAppliedProperties` all use — so a template may be authored in either
 * casing and every stage downstream agrees on the key set.
 *
 * The one place this happens per pipeline (validate, plan, apply, and the
 * module-dispatch seam), rather than in each module by hand, where any one of
 * them can forget. Shallow, per `case-convention.md`: nested value
 * bags — a policy `document`, orchestration node expressions, free-form
 * `metadata` — are copied as values and never inspected.
 */
export const normalizeDeclaredProperties = (
  properties: Record<string, unknown>
): Record<string, unknown> => {
  return isPlainObject(properties)
    ? normalizePropertyKeys(properties)
    : properties;
};

/**
 * Applies the "an undefined property reuses the previous value" rule and
 * reports whether the result differs from `previous`.
 *
 * A property resolving to `undefined` means its parameter was kept: reuse the
 * previous value where there is one, otherwise drop the field so the underlying
 * resource preserves what it has (a secret's encrypted value is never
 * re-applied).
 *
 * `plan-formation` and apply both need this verdict, so it is defined once: two
 * implementations disagree, and comparing `JSON.stringify` of the whole object
 * reports a change on differing key order alone. The per-declared-key deep
 * comparison here is the definition — only declared keys can change.
 */
export const mergeWithPrevious = (args: {
  resolved: Record<string, unknown>;
  previous: Record<string, unknown>;
}): { merged: Record<string, unknown>; changed: boolean } => {
  const { resolved, previous } = args;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (value === undefined) {
      if (key in previous) merged[key] = previous[key];
    } else {
      merged[key] = value;
    }
  }
  const changed = Object.entries(merged).some(([key, value]) => {
    return !isDeepStrictEqual(previous[key], value);
  });
  return { merged, changed };
};
