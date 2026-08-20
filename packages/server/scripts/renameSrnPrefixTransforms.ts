/**
 * The pure rewrite behind `renameSrnPrefix.ts`, kept separate so it can be
 * tested without a database and without running the migration's entry point.
 */

export type Json = unknown;

/**
 * A resource name in its retired spelling: `soat:<project>:<type>:<id>`, the
 * same four-segment shape `isValidSrnPattern` enforces in `src/lib/iam.ts`.
 *
 * The four-segment requirement is what keeps condition keys out of scope —
 * `soat:ResourceTag/env` and `soat:ResourceType` have two segments and keep
 * their prefix in this change.
 */
const LEGACY_SRN = /^soat:[^:]+:[^:]+:[^:]+$/;

/**
 * Rewrite `soat:<project>:<type>:<id>` resource names to `srn:…`.
 *
 * Only string **values** are considered — object keys are never touched, so a
 * `soat:ResourceTag/<key>` condition key cannot be reached even in principle
 * (`.claude/rules/case-convention.md`). A `soat:` string that is not a
 * well-formed SRN is left alone: it was already invalid before the rename, so
 * rewriting it would only invent a shape the validator never accepted.
 */
export const renameSrnPrefix = (value: Json): Json => {
  if (typeof value === 'string') {
    return LEGACY_SRN.test(value)
      ? `srn:${value.slice('soat:'.length)}`
      : value;
  }
  if (Array.isArray(value)) return value.map(renameSrnPrefix);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>).map(([key, entry]) => {
        return [key, renameSrnPrefix(entry)];
      })
    );
  }
  return value;
};
