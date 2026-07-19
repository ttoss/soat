import type { Tool } from 'ai';
import { jsonSchema } from 'ai';
import createDebug from 'debug';

import {
  computeToolCallDedupKey,
  DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS,
  injectApprovalJustificationSchema,
  resolvedActionName,
  stripApprovalJustification,
} from './agentToolApproval';
import { emitApproval } from './approvals';
import type { CollectedGuardrail } from './guardrailCollection';
import { collectApplicableGuardrails } from './guardrailCollection';
import {
  buildContextSnapshot,
  buildGuardrailSoatContext,
  type GuardrailCallIdentity,
  referencedSoatPaths,
  resolveEffectiveContext,
  type SoatRunContext,
} from './guardrailContext';
import {
  type ComposedGuardrailDecision,
  evaluateGuardrail,
  type GuardrailDecision,
  type GuardrailEvaluationResult,
  strictestDecision,
} from './guardrailEvaluation';
import {
  buildEvaluationRecord,
  type GuardrailEvaluationRecord,
  persistGuardrailEvaluations,
} from './guardrailEvaluationRecord';

const log = createDebug('soat:guardrails');

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toIso = (value: unknown): string => {
  return value instanceof Date ? value.toISOString() : String(value);
};

/**
 * The per-generation context the guardrail interceptor needs, built at the
 * generation entry point (where agent / generation / project / session and the
 * caller's `guardrail_context` are all known). `baseGuardrails` are the project-
 * and agent-scope guardrails, collected once; the tool-scope ones are collected
 * per tool in the gate. Threaded into the resolver alongside the M1 approval
 * context, never assembled inside the resolver.
 */
export type ResolverGuardrailContext = {
  agentId: string;
  generationId: string;
  projectId: number;
  projectPublicId: string;
  sessionId?: string | null;
  authHeader?: string;
  callerContext: Record<string, unknown>;
  runId?: string | null;
  run?: SoatRunContext | null;
  baseGuardrails: CollectedGuardrail[];
};

/**
 * Builds the resolver guardrail context. Collects the project- and agent-scope
 * guardrails once. Always returns a context (never `undefined`): tool-scope
 * guardrails are discovered per tool, so the gate can't be skipped up front —
 * but the per-tool gate is a cheap passthrough when nothing applies.
 */
export const buildResolverGuardrailContext = async (args: {
  agentId: string;
  generationId: string;
  projectId: number;
  projectPublicId: string;
  projectGuardrailIds?: string[] | null;
  agentGuardrailIds?: string[] | null;
  sessionId?: string | null;
  authHeader?: string;
  guardrailContext?: Record<string, unknown> | null;
  runId?: string | null;
  run?: SoatRunContext | null;
}): Promise<ResolverGuardrailContext> => {
  const baseGuardrails = await collectApplicableGuardrails({
    projectId: args.projectId,
    projectGuardrailIds: args.projectGuardrailIds,
    agentGuardrailIds: args.agentGuardrailIds,
  });

  return {
    agentId: args.agentId,
    generationId: args.generationId,
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    sessionId: args.sessionId ?? null,
    authHeader: args.authHeader,
    callerContext: isPlainObject(args.guardrailContext)
      ? args.guardrailContext
      : {},
    runId: args.runId ?? null,
    run: args.run ?? null,
    baseGuardrails,
  };
};

// Whether any applying guardrail can ever route to approval — the trigger for
// injecting the model-visible justification fields. A pure A/D literal, or a B
// literal without `escalate`, never files an item; anything else (C, a class
// expression, or an escalating B) can.
const canRouteToApproval = (guardrails: CollectedGuardrail[]): boolean => {
  return guardrails.some((guardrail) => {
    const { document } = guardrail;
    if (typeof document.class !== 'string') return true; // expression → unknown
    if (document.class === 'C') return true;
    if (document.class === 'B' && document.escalate === true) return true;
    return false;
  });
};

type EvaluatedGuardrail = {
  result: GuardrailEvaluationResult;
  record: GuardrailEvaluationRecord;
};

/**
 * Evaluates every applying guardrail against one call, each with its own
 * effective `context.*` (caller context combined with its context tool per
 * `context_mode`) over shared `args.*` and `soat.*`. Returns the composed
 * (strictest) decision plus per-guardrail records for the audit trail.
 */
const evaluateAll = async (args: {
  guardrails: CollectedGuardrail[];
  effectiveArgs: Record<string, unknown>;
  identity: GuardrailCallIdentity;
  context: ResolverGuardrailContext;
}): Promise<{
  composed: ComposedGuardrailDecision;
  evaluated: EvaluatedGuardrail[];
}> => {
  const now = new Date();
  const soat = await buildGuardrailSoatContext({
    identity: args.identity,
    referencedSoatPaths: referencedSoatPaths(args.guardrails),
    now,
  });

  const evaluated: EvaluatedGuardrail[] = [];
  for (const guardrail of args.guardrails) {
    const { context: effectiveContext, source } = await resolveEffectiveContext(
      {
        guardrail,
        callerContext: args.context.callerContext,
        projectId: args.context.projectId,
        authHeader: args.context.authHeader,
        now,
      }
    );
    const evaluationContext = {
      args: args.effectiveArgs,
      context: effectiveContext,
      soat,
    };
    const result = evaluateGuardrail({ guardrail, context: evaluationContext });
    const record = buildEvaluationRecord({
      result,
      contextSource: source,
      contextSnapshot: buildContextSnapshot({ guardrail, evaluationContext }),
      toolName: args.identity.toolName,
      action: args.identity.action,
      agentId: args.context.agentId,
      runId: args.context.runId,
      generationId: args.context.generationId,
    });
    evaluated.push({ result, record });
  }

  const decision = evaluated.reduce<GuardrailDecision>((acc, entry) => {
    return strictestDecision(acc, entry.result.decision);
  }, 'execute');

  return {
    composed: {
      decision,
      evaluations: evaluated.map((entry) => {
        return entry.result;
      }),
    },
    evaluated,
  };
};

// The guardrail whose decision matched the composed (strictest) outcome — its
// version stamps the approval item / provenance. First match wins, matching the
// left-to-right (project → agent → tool) collection order.
const governingResult = (
  evaluated: EvaluatedGuardrail[],
  decision: GuardrailDecision
): GuardrailEvaluationResult | undefined => {
  return evaluated.find((entry) => {
    return entry.result.decision === decision;
  })?.result;
};

/**
 * Wraps one resolved tool's `execute` with the guardrail interceptor. At call
 * time it composes every applying guardrail's decision over the live context and
 * enacts the strictest: `execute` runs the tool; `blocked` (class D) returns a
 * refusal; `route_to_approval` (class C, or an escalating class-B guard failure)
 * files an approval item and returns `pending_approval` (M1 return-pending);
 * `tripwire` (a class-B guard failure) aborts. Every evaluation is written to
 * the audit trail fire-and-forget, never blocking dispatch.
 */
// Justification the model may attach to a proposed call, split off the executed
// arguments and frozen onto the approval item.
type Justification = {
  reasoning: string | null;
  evidence: object | null;
  predictedImpact: string | null;
};

/**
 * The route_to_approval branch: files the item (M1 return-pending / dedup),
 * writes the audit records linked to it, and returns the `pending_approval` tool
 * result. Split out so the wrapped execute stays within its complexity budget.
 */
const routeToApproval = async (args: {
  gate: {
    toolId: string | null;
    toolName: string;
    action: string;
    context: ResolverGuardrailContext;
  };
  effectiveArgs: Record<string, unknown>;
  justification: Justification;
  evaluated: EvaluatedGuardrail[];
  records: GuardrailEvaluationRecord[];
}): Promise<Record<string, unknown>> => {
  const { gate } = args;
  const governing = governingResult(args.evaluated, 'route_to_approval');
  // Inline-tool proposals have no persisted id to re-execute at resolution; use
  // a synthetic marker so the dedup key and item still form.
  const proposalToolId = gate.toolId ?? `inline:${gate.toolName}`;
  const item = await emitApproval({
    projectId: gate.context.projectId,
    origin: 'tool_call',
    proposedAction: {
      toolId: gate.toolId ?? proposalToolId,
      action: gate.action,
      arguments: args.effectiveArgs,
    },
    reasoning: args.justification.reasoning,
    evidence: args.justification.evidence,
    predictedImpact: args.justification.predictedImpact,
    expiresInSeconds: DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS,
    dedupKey: computeToolCallDedupKey({
      projectId: gate.context.projectId,
      agentId: gate.context.agentId,
      toolId: proposalToolId,
      action: gate.action,
      arguments: args.effectiveArgs,
    }),
    generationId: gate.context.generationId,
    agentId: gate.context.agentId,
    sessionId: gate.context.sessionId ?? null,
    policyVersion: governing
      ? `${governing.guardrailId}@${governing.version}`
      : null,
  });

  void persistGuardrailEvaluations({
    projectId: gate.context.projectId,
    toolId: gate.toolId,
    records: args.records,
    approvalId: item.id,
  });

  return {
    status: 'pending_approval',
    approval_id: item.id,
    expires_at: toIso(item.expiresAt),
  };
};

const BLOCK_RESULTS: Record<'blocked' | 'tripwire', Record<string, string>> = {
  blocked: { status: 'blocked', reason: 'Blocked by a guardrail (class D).' },
  tripwire: {
    status: 'tripwire',
    reason:
      'A guardrail tripwire fired: a class-B guard failed and the action was aborted.',
  },
};

const buildGuardedExecute = (args: {
  originalExecute: NonNullable<Tool['execute']>;
  guardrails: CollectedGuardrail[];
  toolId: string | null;
  toolName: string;
  action: string;
  presetParameters?: Record<string, unknown> | null;
  context: ResolverGuardrailContext;
}): NonNullable<Tool['execute']> => {
  return async (...executeArgs) => {
    const modelArgs = isPlainObject(executeArgs[0]) ? executeArgs[0] : {};
    const { cleanArgs, reasoning, evidence, predictedImpact } =
      stripApprovalJustification(modelArgs);
    const effectiveArgs = { ...(args.presetParameters ?? {}), ...cleanArgs };

    const identity: GuardrailCallIdentity = {
      projectId: args.context.projectId,
      projectPublicId: args.context.projectPublicId,
      agentId: args.context.agentId,
      toolId: args.toolId,
      toolName: args.toolName,
      action: args.action,
      runId: args.context.runId,
      run: args.context.run,
    };

    const { composed, evaluated } = await evaluateAll({
      guardrails: args.guardrails,
      effectiveArgs,
      identity,
      context: args.context,
    });
    const { decision } = composed;
    log(
      'guardrail gate: action=%s decision=%s guardrails=%d',
      args.action,
      decision,
      args.guardrails.length
    );
    const records = evaluated.map((entry) => {
      return entry.record;
    });

    if (decision === 'route_to_approval') {
      return routeToApproval({
        gate: {
          toolId: args.toolId,
          toolName: args.toolName,
          action: args.action,
          context: args.context,
        },
        effectiveArgs,
        justification: { reasoning, evidence, predictedImpact },
        evaluated,
        records,
      });
    }

    void persistGuardrailEvaluations({
      projectId: args.context.projectId,
      toolId: args.toolId,
      records,
    });

    if (decision === 'execute') {
      const [, ...rest] = executeArgs;
      return args.originalExecute(cleanArgs, ...rest);
    }
    return BLOCK_RESULTS[decision];
  };
};

/**
 * Applies the guardrail interceptor to every resolved tool produced by one
 * binding (one for most types; many for `mcp` / `soat`). A tool is gated only
 * when at least one guardrail applies to it (project/agent base ∪ its own tool
 * scope) — otherwise it passes through untouched, so guardrail interception is
 * zero-overhead for tools nothing gates. Tools with no `execute` (client tools)
 * are handled at the `requires_action` handoff, not here.
 */
export const gateResolvedToolsWithGuardrails = async (args: {
  tools: Record<string, Tool>;
  toolId: string | null;
  toolType: string;
  toolName: string;
  toolGuardrailIds?: string[] | null;
  presetParameters?: Record<string, unknown> | null;
  rawParameters?: Record<string, unknown> | null;
  context: ResolverGuardrailContext;
}): Promise<Record<string, Tool>> => {
  const toolScoped = args.toolGuardrailIds?.length
    ? await collectApplicableGuardrails({
        projectId: args.context.projectId,
        toolGuardrailIds: args.toolGuardrailIds,
      })
    : [];
  const applicable = [...args.context.baseGuardrails, ...toolScoped];
  if (applicable.length === 0) return args.tools;

  const injectSchema =
    canRouteToApproval(applicable) && args.rawParameters !== undefined;
  const gated: Record<string, Tool> = {};

  for (const [key, resolvedTool] of Object.entries(args.tools)) {
    if (!resolvedTool.execute) {
      gated[key] = resolvedTool;
      continue;
    }
    const action = resolvedActionName({
      type: args.toolType,
      toolName: args.toolName,
      key,
    });
    const guardedExecute = buildGuardedExecute({
      originalExecute: resolvedTool.execute,
      guardrails: applicable,
      toolId: args.toolId,
      toolName: args.toolName,
      action,
      presetParameters: args.presetParameters,
      context: args.context,
    });
    gated[key] = injectSchema
      ? {
          ...resolvedTool,
          inputSchema: jsonSchema(
            injectApprovalJustificationSchema(args.rawParameters)
          ),
          execute: guardedExecute,
        }
      : { ...resolvedTool, execute: guardedExecute };
  }

  return gated;
};
