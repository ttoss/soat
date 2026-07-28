import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { enqueueAuditWrite } from './auditQueue';
import { resolveProjectPublicId } from './eventBus';
import type { GuardrailContextSource } from './guardrailContext';
import type {
  GuardrailDecision,
  GuardrailEvaluationResult,
} from './guardrailEvaluation';

const log = createDebug('soat:guardrails');

// The audit `action` every guardrail-evaluation audit entry carries. No
// principal authorizes the evaluation — it is a platform governance decision —
// so entries are identified by this action with null principal columns, the
// same convention as `quotas:MonitorBreach`.
const GUARDRAIL_EVALUATION_AUDIT_ACTION = 'guardrails:Evaluate';

/**
 * A guardrail evaluation is audit-worthy only when it *changed the call's
 * outcome*: routed it to approval, blocked it, or tripped a tripwire. A plain
 * `execute` is the identity (the call proceeds untouched) and is high-volume
 * operational telemetry — it stays solely in the dedicated
 * `guardrail_evaluations` table and is deliberately kept out of the
 * mutation-focused audit log, which a per-call `execute` firehose would flood.
 * This is the selective-write boundary defined by the audit-log PRD Phase 2.
 */
const isAuditWorthyDecision = (decision: GuardrailDecision): boolean => {
  return decision !== 'execute';
};

/**
 * The `guardrail_evaluation` record — the shape both persisted at dispatch time
 * (task 2.6) and returned by the dry-run endpoint (task 2.9). Mirrors the
 * documented JSON (guardrails.md — Evaluation Audit Record); snake_case is
 * applied by the lib mapper on the way out.
 */
export type GuardrailEvaluationRecord = {
  kind: 'guardrail_evaluation';
  guardrailId: string;
  guardrailVersion: number | null;
  scope: string;
  tool: string | null;
  action: string | null;
  class: string;
  decision: GuardrailDecision;
  guardResult: boolean | null;
  contextSource: GuardrailContextSource;
  contextSnapshot: Record<string, unknown>;
  agentId: string | null;
  orchestrationRunId: string | null;
  generationId: string | null;
};

/**
 * The wire projection of an evaluation record, matching the `GuardrailEvaluation`
 * schema in `openapi/v1/guardrails.yaml`. `context_snapshot` is an opaque,
 * author-owned bag — copied as a value, so its inner keys keep the casing the
 * guardrail's `var` paths are written against.
 */
export const mapGuardrailEvaluation = (record: GuardrailEvaluationRecord) => {
  return {
    kind: record.kind,
    guardrail_id: record.guardrailId,
    guardrail_version: record.guardrailVersion,
    scope: record.scope,
    tool: record.tool,
    action: record.action,
    class: record.class,
    decision: record.decision,
    guard_result: record.guardResult,
    context_source: record.contextSource,
    context_snapshot: record.contextSnapshot,
    agent_id: record.agentId,
    orchestration_run_id: record.orchestrationRunId,
    generation_id: record.generationId,
  };
};

/**
 * Assembles one evaluation record from an engine result plus the call context.
 * `version` 0 (a dangling reference) is surfaced as `null` — there is no real
 * governing version. Pure — no DB, so the dry-run path reuses it verbatim.
 */
export const buildEvaluationRecord = (args: {
  result: GuardrailEvaluationResult;
  contextSource: GuardrailContextSource;
  contextSnapshot: Record<string, unknown>;
  toolName?: string | null;
  action?: string | null;
  agentId?: string | null;
  orchestrationRunId?: string | null;
  generationId?: string | null;
}): GuardrailEvaluationRecord => {
  return {
    kind: 'guardrail_evaluation',
    guardrailId: args.result.guardrailId,
    guardrailVersion: args.result.version === 0 ? null : args.result.version,
    scope: args.result.scope,
    tool: args.toolName ?? null,
    action: args.action ?? null,
    class: args.result.class,
    decision: args.result.decision,
    guardResult: args.result.guardResult,
    contextSource: args.contextSource,
    contextSnapshot: args.contextSnapshot,
    agentId: args.agentId ?? null,
    orchestrationRunId: args.orchestrationRunId ?? null,
    generationId: args.generationId ?? null,
  };
};

/**
 * Mirrors the decision-changing evaluations of a batch into the audit log
 * (audit-log PRD Phase 2). Each such record becomes one `AuditEntry` with
 * `detail.kind = "guardrail_evaluation"` — the full evaluation record verbatim —
 * so the governance decision is queryable on the shared audit substrate the
 * activity feed and SIEM export build on, while the high-volume `execute`
 * records stay solely in the dedicated `guardrail_evaluations` table. Writes are
 * enqueued fire-and-forget on the audit queue; a resolution failure is logged
 * and swallowed so it never affects the tool call being described. The
 * `approvalId` is stamped onto the record that filed it (the sole
 * `route_to_approval` decision in a batch).
 */
const enqueueGuardrailAuditEntries = async (args: {
  projectId: number;
  records: GuardrailEvaluationRecord[];
  approvalId?: string | null;
}): Promise<void> => {
  const worthy = args.records.filter((record) => {
    return isAuditWorthyDecision(record.decision);
  });
  if (worthy.length === 0) return;

  const projectPublicId = await resolveProjectPublicId({
    projectId: args.projectId,
  });
  if (!projectPublicId) return;

  for (const record of worthy) {
    enqueueAuditWrite({
      projectPublicId,
      // Platform-originated: no principal authorized the evaluation, so the
      // principal columns stay null and the entry is identified by its action.
      action: GUARDRAIL_EVALUATION_AUDIT_ACTION,
      resourceSrn: `soat:${projectPublicId}:guardrail:${record.guardrailId}`,
      resourcePublicId: record.guardrailId,
      // The evaluation event itself was recorded successfully; the enacted
      // outcome lives in `detail.decision`, not in this HTTP-shaped field
      // (one tool call can produce several evaluations with different
      // decisions but a single HTTP response).
      status: 200,
      detail: {
        ...record,
        // Only the routed record filed an approval item; the others did not.
        approvalId:
          record.decision === 'route_to_approval'
            ? (args.approvalId ?? null)
            : null,
      },
    });
  }
};

/**
 * Persists one row per evaluation record — the append-only audit trail. Called
 * fire-and-forget from the dispatch gate and never throws: a failure to write
 * the audit record must not fail (or block) the tool call it describes. The
 * `approvalId` links a class-C record to the item it filed.
 */
export const persistGuardrailEvaluations = async (args: {
  projectId: number;
  toolId?: string | null;
  records: GuardrailEvaluationRecord[];
  approvalId?: string | null;
}): Promise<void> => {
  try {
    await db.GuardrailEvaluation.bulkCreate(
      args.records.map((record) => {
        return {
          // bulkCreate skips the model's beforeValidate publicId hook, so mint
          // the id here.
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.guardrailEvaluation),
          projectId: args.projectId,
          guardrailId: record.guardrailId,
          guardrailVersion: record.guardrailVersion,
          scope: record.scope,
          toolId: args.toolId ?? null,
          toolName: record.tool,
          action: record.action,
          resolvedClass: record.class,
          decision: record.decision,
          guardResult: record.guardResult,
          contextSource: record.contextSource,
          contextSnapshot: record.contextSnapshot,
          agentId: record.agentId,
          orchestrationRunId: record.orchestrationRunId,
          generationId: record.generationId,
          approvalId: args.approvalId ?? null,
        };
      })
    );
    log(
      'persistGuardrailEvaluations: projectId=%d wrote=%d',
      args.projectId,
      args.records.length
    );

    await enqueueGuardrailAuditEntries({
      projectId: args.projectId,
      records: args.records,
      approvalId: args.approvalId,
    });
  } catch (error) {
    log(
      'persistGuardrailEvaluations: failed projectId=%d %o',
      args.projectId,
      error
    );
  }
};
