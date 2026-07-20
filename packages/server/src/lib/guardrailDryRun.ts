import createDebug from 'debug';

import { db } from '../db';
import {
  buildContextSnapshot,
  buildGuardrailSoatContext,
  type GuardrailCallIdentity,
  referencedSoatPaths,
  resolveEffectiveContext,
} from './guardrailContext';
import { evaluateGuardrail } from './guardrailEvaluation';
import {
  buildEvaluationRecord,
  type GuardrailEvaluationRecord,
} from './guardrailEvaluationRecord';
import { loadGuardrailForEvaluation } from './guardrails';

const log = createDebug('soat:guardrails');

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Dry-runs the full evaluation pipeline for one guardrail (task 2.9): resolves
 * the class expression, the guard, the context tool per `context_mode`, and live
 * `soat.*`, over caller-supplied `args` / `guardrail_context`, and returns the
 * exact {@link GuardrailEvaluationRecord} a real call would produce. Nothing
 * executes, no approval item is filed, and no audit row is written — the
 * adoption path before attaching a guardrail (or before editing a widely-attached
 * one). Fail-closed exactly as at runtime: a failing context tool or a missing
 * `soat.*`/`context.*` key resolves the class to `default_class` and fails the
 * guard.
 */
export const evaluateGuardrailDryRun = async (args: {
  projectIds?: number[];
  guardrailId: string;
  args?: object;
  guardrailContext?: object;
  toolId?: string;
  authHeader?: string;
}): Promise<GuardrailEvaluationRecord> => {
  log(
    'evaluateGuardrailDryRun: id=%s toolId=%s',
    args.guardrailId,
    args.toolId ?? '(none)'
  );

  const { guardrail, projectId, projectPublicId } =
    await loadGuardrailForEvaluation({
      projectIds: args.projectIds,
      id: args.guardrailId,
    });

  // Resolve soat.tool.* from the optional tool_id, exactly as the dispatch path
  // would (a tool outside the caller's projects simply leaves the name null).
  let toolName: string | null = null;
  if (args.toolId) {
    const tool = await db.Tool.findOne({
      where: { publicId: args.toolId, projectId },
      attributes: ['name'],
    });
    toolName = tool?.name ?? null;
  }

  const callArgs = isPlainObject(args.args) ? args.args : {};
  const callerContext = isPlainObject(args.guardrailContext)
    ? args.guardrailContext
    : {};

  const now = new Date();
  const identity: GuardrailCallIdentity = {
    projectId,
    projectPublicId,
    toolId: args.toolId ?? null,
    toolName,
    action: toolName,
  };
  const soat = await buildGuardrailSoatContext({
    identity,
    referencedSoatPaths: referencedSoatPaths([guardrail]),
    now,
  });

  const { context: effectiveContext, source } = await resolveEffectiveContext({
    guardrail,
    callerContext,
    projectId,
    authHeader: args.authHeader,
    now,
  });

  const evaluationContext = {
    args: callArgs,
    context: effectiveContext,
    soat,
  };
  const result = evaluateGuardrail({ guardrail, context: evaluationContext });

  return buildEvaluationRecord({
    result,
    contextSource: source,
    contextSnapshot: buildContextSnapshot({ guardrail, evaluationContext }),
    toolName,
    action: toolName,
  });
};
