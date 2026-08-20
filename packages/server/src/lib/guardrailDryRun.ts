import createDebug from 'debug';

import { db } from '../db';
import {
  buildContextSnapshot,
  buildGuardrailRuntimeContext,
  type GuardrailCallIdentity,
  referencedRuntimePaths,
  resolveEffectiveContext,
} from './guardrailContext';
import { evaluateGuardrail } from './guardrailEvaluation';
import {
  buildEvaluationRecord,
  mapGuardrailEvaluation,
} from './guardrailEvaluationRecord';
import { loadGuardrailForEvaluation } from './guardrails';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:guardrails');

/**
 * Dry-runs the full evaluation pipeline for one guardrail (task 2.9): resolves
 * the class expression, the guard, the context tool per `context_mode`, and live
 * `runtime.*`, over caller-supplied `args` / `guardrail_context`, and returns the
 * exact {@link GuardrailEvaluationRecord} a real call would produce. Nothing
 * executes, no approval item is filed, and no audit row is written — the
 * adoption path before attaching a guardrail (or before editing a widely-attached
 * one). Fail-closed exactly as at runtime: a failing context tool or a missing
 * `runtime.*`/`context.*` key resolves the class to `default_class` and fails the
 * guard.
 */
export const evaluateGuardrailDryRun = async (args: {
  projectIds?: number[];
  guardrailId: string;
  args?: object;
  guardrailContext?: object;
  toolId?: string;
  authHeader?: string;
}): Promise<ReturnType<typeof mapGuardrailEvaluation>> => {
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

  // Resolve runtime.tool.* from the optional tool_id, exactly as the dispatch path
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
  const runtime = await buildGuardrailRuntimeContext({
    identity,
    referencedRuntimePaths: referencedRuntimePaths([guardrail]),
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
    runtime,
  };
  const result = evaluateGuardrail({ guardrail, context: evaluationContext });

  return mapGuardrailEvaluation(
    buildEvaluationRecord({
      result,
      contextSource: source,
      contextSnapshot: buildContextSnapshot({ guardrail, evaluationContext }),
      toolName,
      action: toolName,
    })
  );
};
