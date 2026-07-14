import { DomainError } from '../errors';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import type { NodeExecutionResult } from './orchestrationNodeExecutors';
import type { OrchestrationNode } from './orchestrations';

/**
 * The frozen proposal an `approval` node hands to the engine, which emits it as
 * an ApprovalItem (linked to the parked run) when the run settles.
 */
export type ApprovalNodeSpec = {
  toolId: string;
  arguments: Record<string, unknown>;
  reasoning: string | null;
  evidence: object | null;
  predictedImpact: string | null;
  expiresInSeconds: number;
};

// Absent `expires_in`, an approval defaults to a 24h window — long enough for a
// human queue but bounded so a stale proposal can never sit forever.
const DEFAULT_APPROVAL_EXPIRES_IN_SECONDS = 24 * 60 * 60;

const asStringOrNull = (value: unknown): string | null => {
  return value === null || value === undefined ? null : String(value);
};

const asObjectOrNull = (value: unknown): object | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
};

const resolveExpiresIn = (expiresIn: number | undefined): number => {
  return typeof expiresIn === 'number' && expiresIn > 0
    ? expiresIn
    : DEFAULT_APPROVAL_EXPIRES_IN_SECONDS;
};

/**
 * Resolves an `approval` node's mappings against run state and returns a
 * `requires_action` carrying the frozen proposal. The node parks the run
 * (like `human`); the engine emits the ApprovalItem at settle time and
 * resolution resumes the run with the decision (§4.1 of the PRD).
 */
export const executeApprovalNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  if (!node.toolId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Approval node '${node.id}' missing toolId.`
    );

  const resolvedArguments = applyInputMapping(node.arguments, state);
  const approvalSpec: ApprovalNodeSpec = {
    toolId: node.toolId,
    arguments: resolvedArguments,
    reasoning:
      node.reasoning === undefined
        ? null
        : asStringOrNull(evaluateLogic(node.reasoning, state)),
    evidence:
      node.evidence === undefined
        ? null
        : asObjectOrNull(evaluateLogic(node.evidence, state)),
    predictedImpact:
      node.predictedImpact === undefined
        ? null
        : asStringOrNull(evaluateLogic(node.predictedImpact, state)),
    expiresInSeconds: resolveExpiresIn(node.expiresIn),
  };

  return {
    kind: 'requires_action',
    type: 'approval',
    nodeId: node.id,
    prompt: node.instructions ?? 'Approval required.',
    context: resolvedArguments,
    approvalSpec,
  };
};
