import { DomainError } from '../errors';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import {
  type NodeExecutionResult,
  parseDuration,
} from './orchestrationNodeExecutors';
import type { OrchestrationNode } from './orchestrations';
import { callTool } from './tools';

// Poll node safety bounds. `maxIterations` caps the number of attempts. There
// is no longer a wall-clock ceiling: each attempt runs in its own scheduled
// resumption rather than inside a single held-open HTTP request, so the only
// bound that matters is the attempt cap.
const DEFAULT_POLL_ATTEMPTS = 10;
const MAX_POLL_ATTEMPTS = 1000;

/**
 * Validates a poll node's three required fields and returns the ones the
 * compiler cannot otherwise narrow. Kept separate from {@link executePollNode}
 * so the executor stays simple.
 */
const assertPollNode = (
  node: OrchestrationNode
): { toolId: string; interval: string } => {
  if (!node.toolId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Poll node '${node.id}' missing toolId.`
    );
  if (node.exitCondition === undefined || node.exitCondition === null)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Poll node '${node.id}' missing exitCondition.`
    );
  if (!node.interval)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Poll node '${node.id}' missing interval.`
    );
  return { toolId: node.toolId, interval: node.interval };
};

/**
 * Executes a single poll attempt. Calls `toolId` (with `inputMapping` resolved
 * against state), then evaluates `exitCondition` against an augmented context —
 * `{ ...state, response, attempt }` — where `response` is the latest tool
 * result and `attempt` is the 1-based count. Returns:
 *
 * - an `artifact` result when the condition is met (`conditionMet: true`);
 * - an `artifact` result when the attempt cap is reached without the condition
 *   holding (`conditionMet: false`, `timedOut: true`), or throws when
 *   `failOnTimeout` is set;
 * - a `wait` result when more attempts remain, so the scheduler resumes the
 *   node after `interval` for the next attempt.
 *
 * The wait between attempts is no longer an in-process sleep: it is offloaded
 * to the background scheduler, so a poll never holds an HTTP request open.
 */
export const executePollNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  authHeader?: string;
  attempt?: number;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader } = args;
  const { toolId, interval } = assertPollNode(node);

  const { maxIterations = DEFAULT_POLL_ATTEMPTS } = node;
  const intervalMs = parseDuration(interval);
  const maxAttempts = Math.min(Math.max(maxIterations, 1), MAX_POLL_ATTEMPTS);
  const attempt = Math.max(args.attempt ?? 1, 1);

  const inputs = applyInputMapping(node.inputMapping, state);
  const lastResponse = await callTool({
    projectIds,
    id: toolId,
    action: node.operationId,
    input: inputs,
    authHeader,
  });

  const context = { ...state, response: lastResponse, attempt };
  if (evaluateLogic(node.exitCondition, context)) {
    return {
      kind: 'artifact',
      artifact: {
        result: lastResponse,
        attempts: attempt,
        conditionMet: true,
        timedOut: false,
      },
    };
  }

  if (attempt >= maxAttempts) {
    if (node.failOnTimeout)
      throw new DomainError(
        'ORCHESTRATION_POLL_EXHAUSTED',
        `Poll node '${node.id}' exhausted after ${attempt} attempt(s) without meeting its exit condition.`
      );
    return {
      kind: 'artifact',
      artifact: {
        result: lastResponse,
        attempts: attempt,
        conditionMet: false,
        timedOut: true,
      },
    };
  }

  return {
    kind: 'wait',
    nodeId: node.id,
    resumeInMs: intervalMs,
    resume: { kind: 'poll', attempt: attempt + 1 },
  };
};
