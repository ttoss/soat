/**
 * Shared schema fixture for the `guardrail_evaluation` audit `detail` kind.
 *
 * Audit-log PRD Phase 2 requires a single fixture that both the guardrails kind
 * and the audit-log substrate assert against, so the `detail` schema cannot
 * drift between the two PRDs. It is imported by the guardrail dispatch test
 * (which produces the entries) and the audit-log test (which reads them back),
 * so any change to the record shape must update this one place or fail both.
 *
 * Keys mirror `GuardrailEvaluationRecord` (`src/lib/guardrailEvaluationRecord.ts`)
 * and the documented record in `packages/website/docs/modules/guardrails.md`.
 * The audit `detail` is written camelCase and surfaces snake_case through the
 * caseTransform middleware on the read endpoint, so this fixture is offered in
 * both spellings.
 */

export const GUARDRAIL_EVALUATION_DETAIL_KEYS_CAMEL = [
  'kind',
  'guardrailId',
  'guardrailVersion',
  'scope',
  'tool',
  'action',
  'class',
  'decision',
  'guardResult',
  'contextSource',
  'contextSnapshot',
  'agentId',
  'runId',
  'generationId',
] as const;

export const GUARDRAIL_EVALUATION_DETAIL_KEYS_SNAKE = [
  'kind',
  'guardrail_id',
  'guardrail_version',
  'scope',
  'tool',
  'action',
  'class',
  'decision',
  'guard_result',
  'context_source',
  'context_snapshot',
  'agent_id',
  'run_id',
  'generation_id',
] as const;

/** The four decisions a guardrail evaluation can enact. */
export const GUARDRAIL_DECISIONS = [
  'execute',
  'route_to_approval',
  'blocked',
  'tripwire',
] as const;

/**
 * A guardrail evaluation is audit-worthy only when it changed the call's
 * outcome. `execute` is the identity (the call proceeds untouched) and is kept
 * out of the mutation-focused audit log — it lives solely in the dedicated
 * `guardrail_evaluations` table. This mirrors the production boundary in
 * `persistGuardrailEvaluations`.
 */
export const isAuditWorthyDecision = (decision: string): boolean => {
  return decision !== 'execute';
};

/**
 * Asserts an audit `detail` payload is a well-formed `guardrail_evaluation`
 * record in the given case spelling. Throws (fails the test) on any missing key
 * or wrong `kind`/`decision`.
 */
export const assertGuardrailEvaluationDetail = (
  detail: unknown,
  spelling: 'camel' | 'snake'
): void => {
  if (!detail || typeof detail !== 'object') {
    throw new Error(`detail is not an object: ${JSON.stringify(detail)}`);
  }
  const record = detail as Record<string, unknown>;

  if (record.kind !== 'guardrail_evaluation') {
    throw new Error(
      `detail.kind is not "guardrail_evaluation": ${record.kind}`
    );
  }

  const keys =
    spelling === 'camel'
      ? GUARDRAIL_EVALUATION_DETAIL_KEYS_CAMEL
      : GUARDRAIL_EVALUATION_DETAIL_KEYS_SNAKE;

  for (const key of keys) {
    if (!(key in record)) {
      throw new Error(`detail is missing required key "${key}"`);
    }
  }

  if (
    typeof record.decision !== 'string' ||
    !GUARDRAIL_DECISIONS.includes(
      record.decision as (typeof GUARDRAIL_DECISIONS)[number]
    )
  ) {
    throw new Error(
      `detail.decision is not a known decision: ${record.decision}`
    );
  }
};
