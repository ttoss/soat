import createDebug from 'debug';

import { db } from '../db';
import type { GuardrailDocument } from './guardrailDocument';
import { DEFAULT_ACTION_CLASS } from './guardrailDocument';
import type { AttachedGuardrail, GuardrailScope } from './guardrailEvaluation';

const log = createDebug('soat:guardrails');

/**
 * A guardrail resolved for a call, carrying everything the dispatch path needs:
 * the engine's {@link AttachedGuardrail} (id / version / scope / document) plus
 * the context-tool config, which lives on the guardrail row (not the document)
 * and drives per-guardrail `context.*` resolution.
 */
export type CollectedGuardrail = AttachedGuardrail & {
  contextToolId: string | null;
  contextMode: string;
};

// The document of a dangling reference (a guardrail_id whose guardrail was
// deleted). Evaluating it yields class C → route_to_approval, the documented
// fail-closed behavior (guardrails.md — Deletion). version 0 marks it so the
// audit record can surface it as a null governing version.
const danglingDocument: GuardrailDocument = { class: DEFAULT_ACTION_CLASS };

/**
 * Resolves every guardrail applying to one tool call — the union of the
 * project-, agent-, and tool-scope `guardrail_ids` — into `CollectedGuardrail[]`
 * ready for `evaluateGuardrail`. One entry is produced per (id, scope), so a
 * guardrail attached at two scopes evaluates (and audits) once per scope. A
 * referenced id whose guardrail no longer exists is **not** dropped: it is kept
 * as a dangling entry that fails closed to class C at evaluation time, so a
 * deleted guardrail can never silently open a gate. Documents are loaded at
 * their current version — attachments track the id, and an edit takes effect
 * immediately everywhere (guardrails.md — Versioning).
 */
export const collectApplicableGuardrails = async (args: {
  projectId: number;
  projectGuardrailIds?: string[] | null;
  agentGuardrailIds?: string[] | null;
  toolGuardrailIds?: string[] | null;
}): Promise<CollectedGuardrail[]> => {
  const scoped: { scope: GuardrailScope; ids: string[] }[] = [
    { scope: 'project', ids: args.projectGuardrailIds ?? [] },
    { scope: 'agent', ids: args.agentGuardrailIds ?? [] },
    { scope: 'tool', ids: args.toolGuardrailIds ?? [] },
  ];

  const allIds = [
    ...new Set(
      scoped.flatMap((entry) => {
        return entry.ids;
      })
    ),
  ];
  if (allIds.length === 0) return [];

  const rows = await db.Guardrail.findAll({
    where: { publicId: allIds, projectId: args.projectId },
    attributes: [
      'publicId',
      'version',
      'document',
      'contextToolId',
      'contextMode',
    ],
  });
  const byId = new Map(
    rows.map((row) => {
      return [row.publicId, row];
    })
  );

  const collected: CollectedGuardrail[] = [];
  for (const { scope, ids } of scoped) {
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        // Dangling reference — fail closed to class C.
        collected.push({
          guardrailId: id,
          version: 0,
          scope,
          document: danglingDocument,
          contextToolId: null,
          contextMode: 'merge',
        });
        continue;
      }
      collected.push({
        guardrailId: row.publicId,
        version: row.version,
        scope,
        document: row.document as GuardrailDocument,
        contextToolId: row.contextToolId,
        contextMode: row.contextMode ?? 'merge',
      });
    }
  }

  log(
    'collectApplicableGuardrails: projectId=%d ids=%d collected=%d',
    args.projectId,
    allIds.length,
    collected.length
  );
  return collected;
};
