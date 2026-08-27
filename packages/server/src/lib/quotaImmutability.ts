/**
 * Which quota fields are fixed at creation, and the rule that enforces it.
 *
 * Kept in its own module (like `quotaWindows.ts`) so the rule has one home and
 * `quotas.ts` can re-export it: the REST route and the formation module must
 * never drift apart on what "immutable" means.
 */

/**
 * The fields fixed at creation. `limit` and `mode` are the only mutable ones: a
 * quota's identity is `(project, scope, scope_ref, metric, window)` and its
 * window counters are keyed to that identity, so changing any of it in place
 * would silently re-point live counters at what is really a different cap.
 * `PATCH /quotas/{id}` accepts only `limit`/`mode`, so this is also exactly the
 * set the REST contract already treats as immutable.
 */
export const QUOTA_IMMUTABLE_FIELDS = [
  'scope',
  'scopeRef',
  'metric',
  'window',
] as const;

const WIRE_NAMES: Record<(typeof QUOTA_IMMUTABLE_FIELDS)[number], string> = {
  scope: 'scope',
  scopeRef: 'scope_ref',
  metric: 'metric',
  window: 'window',
};

// `null` is a materially different scope_ref than `""` (see the per-actor
// tests in quotas.test.ts), so it must render as the word "null" rather than
// collapsing into an empty-quoted string in the error message.
const display = (value: string | null): string => {
  return value === null ? 'null' : `"${value}"`;
};

/**
 * Rejects an attempt to change an immutable field, returning the message on the
 * first offender or `null` when the update is allowed.
 *
 * Callers may restate the current value — formation templates always carry
 * `scope`/`metric`/`window` because they are required on create — so only a
 * *different* value is an error. A field left `undefined` ("not supplied") is
 * always allowed, which keeps a template that simply omits the nullable
 * `scope_ref` from reading as an attempt to clear it.
 */
export const validateQuotaImmutableFields = (args: {
  next: {
    scope?: unknown;
    scopeRef?: unknown;
    metric?: unknown;
    window?: unknown;
  };
  current: {
    scope: string;
    scopeRef: string | null;
    metric: string;
    window: string;
  };
}): string | null => {
  for (const field of QUOTA_IMMUTABLE_FIELDS) {
    const next = args.next[field];
    if (next === undefined) continue;

    // A null `scope_ref` ("all entities of this scope type") is a materially
    // different cap from a specific ref, so an explicit null disagreeing with
    // the stored value is still a change. Normalized strings keep null-vs-null
    // equal without special-casing each direction.
    const nextValue = next === null ? '' : String(next);
    const currentValue = args.current[field] ?? '';
    if (nextValue !== currentValue) {
      const nextDisplay = next === null ? null : String(next);
      const currentDisplay = args.current[field];
      return (
        `${WIRE_NAMES[field]} is immutable and cannot be changed after ` +
        `creation (declared ${display(nextDisplay)}, current ` +
        `${display(currentDisplay)}). Replace the quota instead.`
      );
    }
  }
  return null;
};
