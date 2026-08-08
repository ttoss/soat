import { db } from '../db';
import { type ConfigSnapshot, makeVersionStore } from './resourceVersions';

/**
 * How a guardrail's configuration is projected into the shared version archive
 * (`resourceVersions.ts`). Everything generic — the archive write, the
 * change detection, the equality check — lives there.
 *
 * This module holds the archive's **write side** so that `guardrails.ts` can
 * reach it without importing `guardrailVersions.ts`, which imports
 * `guardrails.ts` back for `updateGuardrail`.
 */

/**
 * A guardrail's archived configuration, in the wire (snake_case) shape the
 * guardrails OpenAPI spec documents.
 */
export type GuardrailConfigSnapshot = ConfigSnapshot;

/**
 * Projects a guardrail down to its versioned surface.
 *
 * Unlike an agent — whose whole mutable surface is configuration — a guardrail
 * versions only its policy `document`. Name, description and the context binding
 * are metadata: bumping the version when one of them changes would make two
 * version numbers denote the same policy, and the version number is precisely
 * what an evaluation record cites to say which policy governed a decision.
 *
 * The document is copied as a **value**. It is a caller-authored JSON payload
 * with contract-fixed keys (`default_class`, `guard`, `escalate`) that this
 * platform does not own, so nothing here descends into it or rewrites a key
 * (`.claude/rules/case-convention.md`).
 */
export const buildGuardrailConfigSnapshot = (guardrail: {
  document: object;
}): GuardrailConfigSnapshot => {
  return { document: guardrail.document };
};

/** The write side of the guardrail config archive. */
export const guardrailVersionStore = makeVersionStore({
  resourceLabel: 'Guardrail',
  versionModel: () => {
    return db.GuardrailVersion;
  },
  foreignKey: 'guardrailId',
});
