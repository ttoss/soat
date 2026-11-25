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

import type { PropertyComparison } from './formationsComparison';
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
  return normalizePropertyKeys(properties);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// Fills each `undefined` in `value` from `previous` at the same path; one with
// no previous value is left out, an array item included.
const keepUnresolved = (args: {
  value: unknown;
  previous: unknown;
}): unknown => {
  const { value, previous } = args;
  if (value === undefined) return previous;
  if (Array.isArray(value)) {
    const before = Array.isArray(previous) ? previous : [];
    return value.flatMap((item, index) => {
      const kept = keepUnresolved({ value: item, previous: before[index] });
      return kept === undefined ? [] : [kept];
    });
  }
  if (isPlainObject(value)) {
    const before = isPlainObject(previous) ? previous : {};
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const kept = keepUnresolved({ value: item, previous: before[key] });
      if (kept !== undefined) result[key] = kept;
    }
    return result;
  }
  return value;
};

/**
 * Applies the "an undefined value reuses the previous value" rule and
 * reports whether the result differs from `previous`.
 *
 * A value resolving to `undefined`, at any depth, means its parameter was kept:
 * reuse the previous value at the same path where there is one, otherwise drop
 * the field so the underlying resource preserves what it has (a secret's
 * encrypted value is never re-applied).
 *
 * A property `lastApplied` declared that the template no longer declares is
 * removed: `null` when `clearable` names it (left out of `snapshot`, the
 * `lastAppliedProperties` to persist), else kept at its `previous` value so the
 * plan shows it.
 *
 * `plan-formation` and apply both need this verdict, so it is defined once: two
 * implementations disagree, and comparing `JSON.stringify` of the whole object
 * reports a change on differing key order alone. Both sides are compared
 * through `comparison` (`formationsComparison.ts`).
 */
export const mergeWithPrevious = (args: {
  resolved: Record<string, unknown>;
  previous: Record<string, unknown>;
  lastApplied: Record<string, unknown>;
  clearable: ReadonlySet<string>;
  comparison: PropertyComparison;
}): {
  merged: Record<string, unknown>;
  changed: boolean;
  snapshot: Record<string, unknown>;
} => {
  const { resolved, previous, lastApplied, clearable } = args;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolved)) {
    const kept = keepUnresolved({ value, previous: previous[key] });
    if (kept !== undefined) merged[key] = kept;
  }
  const cleared = new Set<string>();
  for (const key of Object.keys(lastApplied)) {
    if (key in resolved) continue;
    if (clearable.has(key)) {
      merged[key] = null;
      cleared.add(key);
    } else if (key in previous) {
      merged[key] = previous[key];
    }
  }
  const desired = args.comparison.comparable(merged);
  const current = args.comparison.comparable(previous);
  const changed = Object.keys(merged).some((key) => {
    if (args.comparison.settled.has(key)) return false;
    return !isDeepStrictEqual(current[key], desired[key]);
  });
  const snapshot = Object.fromEntries(
    Object.entries(merged).filter(([key]) => {
      return !cleared.has(key);
    })
  );
  return { merged, changed, snapshot };
};
