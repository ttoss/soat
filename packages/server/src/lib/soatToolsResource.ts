/**
 * The spec annotation that says which argument of a call names the thing it
 * acts on: `x-soat-resource` on an operation, read into the derived tool.
 *
 * Its own module so the boundary path can take the type without importing the
 * whole spec-processing surface, and so `soatToolsHelpers.ts` stays inside the
 * module ceiling.
 */

/**
 * Purely factual: `kind` is the resource the id belongs to, not the resource a
 * policy is evaluated against. Mapping one to the other is `resourceScopes.ts`'s
 * job, next to the modules that own the rule.
 */
export type SoatResourceRef = { kind: string; from: string };

/**
 * A half-written `x-soat-resource` (one key, or a non-string value) is dropped
 * rather than carried: a ref missing either half cannot name a resource, and
 * `soatToolsResourceScope.test.ts` fails on a spec that ships one, so this
 * never silently downgrades an annotated operation to `*`.
 */
export const readResourceRef = (
  value: { kind?: string; from?: string } | undefined
): SoatResourceRef | undefined => {
  if (!value) return undefined;
  const { kind, from } = value;
  if (typeof kind !== 'string' || typeof from !== 'string') return undefined;
  if (!kind || !from) return undefined;
  return { kind, from };
};
