/**
 * The rules that govern a formation resource declaration's `properties` bag.
 *
 * Both rules here used to be restated per pipeline, and both had drifted: the
 * key normalization was written out by 20 of 24 modules and skipped by four
 * (#901), and the merge/changed predicate was implemented twice with different
 * semantics, so `plan-formation` could disagree with the apply it previewed
 * (#902). Stated once, in the one module every pipeline imports.
 *
 * Neither function takes, returns, or inspects a field *name*: one rewrites
 * only an object's own keys via the shared shallow normalizer, the other moves
 * whole values. Per `.claude/rules/case-convention.md`, nothing here walks a
 * value rewriting keys at depth.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  isPlainObject,
  normalizePropertyKeys,
} from './resource-inputs/normalizers';

/**
 * Puts a resource declaration's top-level property keys into the snake_case the
 * OpenAPI schemas, the modules' `read()` output, and the persisted
 * `lastAppliedProperties` all use — so a template may be authored in either
 * casing and every stage downstream agrees on the key set.
 *
 * The one place this happens per pipeline (validate, plan, apply, and the
 * module-dispatch seam), because 20 modules doing it by hand and 4 forgetting is
 * exactly how #901 happened. Shallow, per `case-convention.md`: nested value
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
 * A property resolving to `undefined` means its parameter was kept
 * ("use previous value"): reuse the previous value where there is one,
 * otherwise drop the field entirely so the underlying resource preserves what
 * it already has (a secret's encrypted value is never re-applied).
 *
 * `plan-formation` and apply both need this verdict, and both used to compute
 * it — differently (#902). Apply compared `JSON.stringify` of the whole object,
 * which also reported a change when key order differed or when `previous` held
 * a key the template omits. The per-declared-key deep comparison here is the
 * definition: only keys the template declares can be changed by an apply.
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
