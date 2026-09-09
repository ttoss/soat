import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type {
  GuardrailClassification,
  ResolverGuardrailContext,
} from './agentToolGuardrail';
import {
  classifyGuardrailCall,
  governingGuardrailVersion,
} from './agentToolGuardrail';
import { emitGuardrailTripwireEvent } from './exceptionAutoFile';
import { collectApplicableGuardrails } from './guardrailCollection';
import { persistGuardrailEvaluations } from './guardrailEvaluationRecord';

const log = createDebug('soat:guardrails');

/**
 * How a tool call reaches dispatch with respect to guardrails.
 *
 * Required rather than defaulted, on every dispatch entry point, because the
 * cost of forgetting is silent: a tool-scoped guardrail is documented to govern
 * its tool *wherever it is used*, and the paths that skipped the gate did so by
 * omission rather than decision. A new call site does not compile until it says
 * which of these it is, and the answer is readable at the call.
 *
 * - `apply` — nothing has adjudicated this call yet; run the gate here.
 * - `already-adjudicated` — a gate upstream already classified this exact call
 *   and released it (the agent dispatch wrapper, the orchestration `tool` node),
 *   or the call is the guardrail machinery's own and gating it would recurse.
 */
export type ToolCallGuardrailMode = 'apply' | 'already-adjudicated';

type SettledOutcome = 'blocked' | 'tripwire' | 'route_to_approval';

export type DirectToolGateResult =
  | { kind: 'execute'; input: Record<string, unknown> }
  | { kind: 'settled'; outcome: SettledOutcome };

/**
 * Maps a classified decision to what a direct call can do with it: proceed with
 * the cleaned arguments, or settle. A tripwire also emits the event the
 * exceptions module turns into a `guardrail_tripwire` exception, as it does on
 * every other surface.
 */
const enactDirectDecision = (args: {
  classification: GuardrailClassification;
  toolId: string | null;
  toolName: string;
  action: string;
  projectId: number;
  projectPublicId: string;
}): DirectToolGateResult => {
  const { decision, cleanArgs, evaluated } = args.classification;
  if (decision === 'execute') return { kind: 'execute', input: cleanArgs };

  if (decision === 'tripwire') {
    emitGuardrailTripwireEvent({
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
      toolId: args.toolId,
      toolName: args.toolName,
      action: args.action,
      guardrailVersion: governingGuardrailVersion({ evaluated, decision }),
      orchestrationRunId: null,
      nodeId: null,
    });
  }

  return { kind: 'settled', outcome: decision };
};

/**
 * Adjudicates one direct tool call — a `POST /tools/{id}/call`, a pipeline
 * step, or any other dispatch that is not an agent turn or an orchestration
 * node.
 *
 * Composes **project + tool** scope, as the orchestration `tool` node does:
 * there is no agent in scope, so `agentId`/`generationId` are null on the
 * evaluation identity and the audit record. A zero-overhead passthrough when
 * nothing applies.
 */
/** The project's own guardrail scope, and the public id the identity carries. */
const readProjectScope = async (
  projectId: number
): Promise<{ publicId: string; guardrailIds: string[] | null }> => {
  const project = await db.Project.findOne({
    where: { id: projectId },
    attributes: ['publicId', 'guardrailIds'],
  });
  return {
    publicId: (project?.publicId as string) ?? '',
    guardrailIds: project?.guardrailIds ?? null,
  };
};

export const runDirectToolGate = async (args: {
  toolId: string | null;
  toolName: string;
  toolGuardrailIds?: string[] | null;
  action?: string;
  input: Record<string, unknown>;
  presetParameters?: Record<string, unknown> | null;
  projectId: number;
  authHeader?: string;
}): Promise<DirectToolGateResult> => {
  const project = await readProjectScope(args.projectId);

  const guardrails = await collectApplicableGuardrails({
    projectId: args.projectId,
    projectGuardrailIds: project.guardrailIds,
    toolGuardrailIds: args.toolGuardrailIds ?? null,
  });
  if (guardrails.length === 0) {
    return { kind: 'execute', input: args.input };
  }

  const context: ResolverGuardrailContext = {
    agentId: null,
    generationId: null,
    projectId: args.projectId,
    projectPublicId: project.publicId,
    sessionId: null,
    authHeader: args.authHeader,
    callerContext: {},
    orchestrationRunId: null,
    run: { nodeAttempt: null },
    baseGuardrails: [],
  };

  const action = args.action ?? args.toolName;
  const classification = await classifyGuardrailCall({
    modelArgs: args.input,
    guardrails,
    toolId: args.toolId,
    toolName: args.toolName,
    action,
    presetParameters: args.presetParameters ?? null,
    context,
  });

  void persistGuardrailEvaluations({
    projectId: args.projectId,
    toolId: args.toolId,
    records: classification.records,
  });

  log(
    'runDirectToolGate: tool=%s action=%s decision=%s',
    args.toolId ?? args.toolName,
    action,
    classification.decision
  );

  return enactDirectDecision({
    classification,
    toolId: args.toolId,
    toolName: args.toolName,
    action,
    projectId: args.projectId,
    projectPublicId: project.publicId,
  });
};

/**
 * The gate as a guard: proceeds with the cleaned arguments, or throws.
 *
 * Every non-`execute` decision throws here, including `route_to_approval`. A
 * direct call has no turn to return a `pending_approval` result into and no run
 * to park, so sign-off cannot be awaited — the same reason a workflow `tool`
 * dispatch fails on one. An approval-gated tool belongs behind an agent or an
 * orchestration, whose dispatch can park and resume.
 */
export const assertToolCallAllowed = async (args: {
  toolId: string | null;
  toolName: string;
  toolGuardrailIds?: string[] | null;
  action?: string;
  input: Record<string, unknown>;
  presetParameters?: Record<string, unknown> | null;
  projectId: number;
  authHeader?: string;
}): Promise<Record<string, unknown>> => {
  const gate = await runDirectToolGate(args);
  if (gate.kind === 'execute') return gate.input;

  throw new DomainError(
    'TOOL_DISPATCH_FAILED',
    `Tool call did not run: it was settled as '${gate.outcome}' by a guardrail before dispatch.`,
    { tool_id: args.toolId, outcome: gate.outcome }
  );
};
