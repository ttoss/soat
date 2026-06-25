import { DomainError } from '../errors';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import {
  type NodeExecutionResult,
  parseDuration,
} from './orchestrationNodeExecutors';
import type { OrchestrationNode } from './orchestrations';
import { callTool } from './tools';

// Poll node safety bounds. `maxIterations` caps the number of attempts; the
// wall-clock ceiling protects the request held open by the synchronous run loop
// regardless of per-attempt tool latency.
const DEFAULT_POLL_ATTEMPTS = 10;
const MAX_POLL_ATTEMPTS = 1000;
const MAX_POLL_WALL_CLOCK_MS = 10 * 60 * 1000;

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
  if (node.expression === undefined || node.expression === null)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Poll node '${node.id}' missing expression (the exit condition).`
    );
  if (!node.interval)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Poll node '${node.id}' missing interval.`
    );
  return { toolId: node.toolId, interval: node.interval };
};

/**
 * Polls a tool until a JSON Logic exit condition is satisfied. Each attempt
 * calls `toolId` (with `inputMapping` resolved against state), then evaluates
 * `expression` against an augmented context — `{ ...state, response, attempt }`
 * — where `response` is the latest tool result and `attempt` is the 1-based
 * count. Stops on a truthy condition, or when `maxIterations` (default 10) /
 * the wall-clock ceiling is reached. On exhaustion it either fails the run
 * (`failOnTimeout: true`) or completes with `conditionMet: false`.
 */
export const executePollNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  authHeader?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader } = args;
  const { toolId, interval } = assertPollNode(node);

  const { maxIterations = DEFAULT_POLL_ATTEMPTS } = node;
  const intervalMs = parseDuration(interval);
  const maxAttempts = Math.min(Math.max(maxIterations, 1), MAX_POLL_ATTEMPTS);
  const deadline = Date.now() + MAX_POLL_WALL_CLOCK_MS;

  let attempt = 0;
  let lastResponse: unknown = null;
  for (;;) {
    attempt += 1;
    const inputs = applyInputMapping(node.inputMapping, state);
    lastResponse = await callTool({
      projectIds,
      id: toolId,
      action: node.operationId,
      input: inputs,
      authHeader,
    });

    const context = { ...state, response: lastResponse, attempt };
    if (evaluateLogic(node.expression, context)) {
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

    if (attempt >= maxAttempts || Date.now() >= deadline) {
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

    await new Promise<void>((resolve) => {
      return setTimeout(resolve, intervalMs);
    });
  }
};
