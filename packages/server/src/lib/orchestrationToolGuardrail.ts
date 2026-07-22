import createDebug from 'debug';

import { db } from '../db';
import { DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS } from './agentToolApproval';
import type { ResolverGuardrailContext } from './agentToolGuardrail';
import { classifyGuardrailCall } from './agentToolGuardrail';
import type { CollectedGuardrail } from './guardrailCollection';
import { collectApplicableGuardrails } from './guardrailCollection';
import { persistGuardrailEvaluations } from './guardrailEvaluationRecord';
import type { ApprovalNodeSpec } from './orchestrationApprovalNode';
import type { NodeExecutionResult } from './orchestrationNodeExecutors';
import type { OrchestrationNode } from './orchestrations';

const log = createDebug('soat:guardrails');

/**
 * The result of gating one `tool` node call:
 * - `execute` — proceed to dispatch the tool with `input`.
 * - `result` — the node is settled by the guardrail without dispatching: a
 *   routable `blocked` outcome (class D / tripwire) or a `requires_action`
 *   approval park (class C). The engine records it as the node's result.
 */
export type ToolNodeGateResult =
  | { kind: 'execute'; input: Record<string, unknown> }
  | { kind: 'result'; result: NodeExecutionResult };

const BLOCK_REASON: Record<'blocked' | 'tripwire', string> = {
  blocked: 'Blocked by a guardrail (class D).',
  tripwire:
    'A guardrail tripwire fired: a class-B guard failed and the action was aborted.',
};

/**
 * Collects the guardrails applying to a `tool` node: **project + tool** scope
 * only (a tool node has no agent in scope). Loads the referenced tool's
 * `guardrailIds` and the run project's `guardrailIds`, then resolves them to
 * documents. Returns the tool name alongside for the evaluation identity.
 */
const collectToolNodeGuardrails = async (args: {
  toolId: string;
  projectId: number;
}): Promise<{
  guardrails: CollectedGuardrail[];
  toolName: string;
  projectPublicId: string;
}> => {
  const [tool, project] = await Promise.all([
    db.Tool.findOne({
      where: { publicId: args.toolId, projectId: args.projectId },
      attributes: ['name', 'guardrailIds'],
    }),
    db.Project.findOne({
      where: { id: args.projectId },
      attributes: ['publicId', 'guardrailIds'],
    }),
  ]);

  const guardrails = await collectApplicableGuardrails({
    projectId: args.projectId,
    projectGuardrailIds: project?.guardrailIds ?? null,
    toolGuardrailIds: tool?.guardrailIds ?? null,
  });

  return {
    guardrails,
    toolName: tool?.name ?? args.toolId,
    projectPublicId: project?.publicId ?? '',
  };
};

const blockedResult = (args: {
  node: OrchestrationNode;
  label: 'blocked' | 'tripwire';
}): NodeExecutionResult => {
  const reason = BLOCK_REASON[args.label];
  return {
    kind: 'blocked',
    nodeId: args.node.id,
    label: args.label,
    artifact: { status: args.label, reason },
  };
};

const approvalResult = (args: {
  node: OrchestrationNode;
  toolId: string;
  effectiveArgs: Record<string, unknown>;
  reasoning: string | null;
  evidence: object | null;
  predictedImpact: string | null;
}): NodeExecutionResult => {
  const approvalSpec: ApprovalNodeSpec = {
    toolId: args.toolId,
    arguments: args.effectiveArgs,
    reasoning: args.reasoning,
    evidence: args.evidence,
    predictedImpact: args.predictedImpact,
    expiresInSeconds: DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS,
  };
  return {
    kind: 'requires_action',
    type: 'approval',
    nodeId: args.node.id,
    prompt: args.node.instructions ?? 'Approval required for tool call.',
    context: args.effectiveArgs,
    approvalSpec,
  };
};

/**
 * Gates one orchestration `tool` node call through the shared guardrail
 * classify core and maps the decision to a node result. A zero-overhead
 * passthrough (`execute`) when no guardrail applies. Enacts the strictest
 * decision: `blocked`/`tripwire` → a routable `blocked` node outcome (Q3);
 * `route_to_approval` → a `requires_action` approval that parks the run (Q4);
 * `execute` → proceed with the cleaned args. Audit records are persisted
 * fire-and-forget. The evaluation identity carries `agentId`/`generationId` as
 * `null` — a tool node has no agent in scope (Q1/Q2).
 */
export const runToolNodeGate = async (args: {
  node: OrchestrationNode;
  inputs: Record<string, unknown>;
  projectId: number;
  authHeader?: string;
  runId?: string | null;
  nodeAttempt?: number | null;
}): Promise<ToolNodeGateResult> => {
  const toolId = args.node.toolId;
  if (!toolId) return { kind: 'execute', input: args.inputs };

  const { guardrails, toolName, projectPublicId } =
    await collectToolNodeGuardrails({ toolId, projectId: args.projectId });
  if (guardrails.length === 0) {
    return { kind: 'execute', input: args.inputs };
  }

  const context: ResolverGuardrailContext = {
    agentId: null,
    generationId: null,
    projectId: args.projectId,
    projectPublicId,
    sessionId: null,
    authHeader: args.authHeader,
    callerContext: {},
    runId: args.runId ?? null,
    run: { nodeAttempt: args.nodeAttempt ?? null },
    baseGuardrails: [],
  };

  const { decision, cleanArgs, effectiveArgs, justification, records } =
    await classifyGuardrailCall({
      modelArgs: args.inputs,
      guardrails,
      toolId,
      toolName,
      action: args.node.operationId ?? toolName,
      presetParameters: null,
      context,
    });

  void persistGuardrailEvaluations({
    projectId: args.projectId,
    toolId,
    records,
  });
  log(
    'runToolNodeGate: node=%s tool=%s decision=%s',
    args.node.id,
    toolId,
    decision
  );

  if (decision === 'route_to_approval') {
    return {
      kind: 'result',
      result: approvalResult({
        node: args.node,
        toolId,
        effectiveArgs,
        reasoning: justification.reasoning,
        evidence: justification.evidence,
        predictedImpact: justification.predictedImpact,
      }),
    };
  }
  if (decision === 'blocked' || decision === 'tripwire') {
    return {
      kind: 'result',
      result: blockedResult({ node: args.node, label: decision }),
    };
  }
  return { kind: 'execute', input: cleanArgs };
};
