import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import type { GuardrailContextSource } from './guardrailContext';
import type {
  GuardrailDecision,
  GuardrailEvaluationResult,
} from './guardrailEvaluation';

const log = createDebug('soat:guardrails');

/**
 * The `guardrail_evaluation` record — the shape both persisted at dispatch time
 * (task 2.6) and returned by the dry-run endpoint (task 2.9). Mirrors the
 * documented JSON (guardrails.md — Evaluation Audit Record); snake_case is
 * applied by the caseTransform middleware on the way out.
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
  runId: string | null;
  generationId: string | null;
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
  runId?: string | null;
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
    runId: args.runId ?? null,
    generationId: args.generationId ?? null,
  };
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
          runId: record.runId,
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
  } catch (error) {
    log(
      'persistGuardrailEvaluations: failed projectId=%d %o',
      args.projectId,
      error
    );
  }
};
