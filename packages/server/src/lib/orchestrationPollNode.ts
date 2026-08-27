import { DomainError } from '../errors';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import { parseDuration } from './orchestrationDuration';
import { requireNodeField } from './orchestrationNodeFields';
import type { NodeExecutionResult } from './orchestrationNodeTypes';
import type { OrchestrationNode } from './orchestrations';
import { callTool } from './tools';

// No wall-clock ceiling: each attempt runs in its own scheduled resumption
// rather than a single held-open request, so the attempt cap is the only bound
// that matters.
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
  const toolId = requireNodeField(node, 'toolId');
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
  return { toolId, interval: node.interval };
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
  // The run's `tool_context` — a poll node is the run calling a tool on its own
  // behalf, so it carries the run's context like a `tool` node does (#345).
  toolContext?: Record<string, string>;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, toolContext } = args;
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
    toolContext,
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
