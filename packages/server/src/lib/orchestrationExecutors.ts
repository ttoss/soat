import { DomainError } from '../errors';
import { resolveNextNodes } from './orchestrationGraph';
import type {
  NodeExecutionResult,
  WaitResume,
} from './orchestrationNodeExecutors';
import {
  applyOutputMapping,
  executeAgentNode,
  executeConditionNode,
  executeDelayNode,
  executeHumanNode,
  executeKnowledgeNode,
  executeLoopNode,
  executeMemoryWriteNode,
  executeSubOrchestrationNode,
  executeToolNode,
  executeTransformNode,
  executeWebhookNode,
} from './orchestrationNodeExecutors';
import { executePollNode } from './orchestrationPollNode';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';

export {
  detectCycle,
  findStartNodes,
  resolveNextNodes,
} from './orchestrationGraph';
export type { NodeExecutionResult } from './orchestrationNodeExecutors';
export {
  applyInputMapping,
  applyOutputMapping,
} from './orchestrationNodeExecutors';

// ── Types ─────────────────────────────────────────────────────────────────

export type RequiredAction = {
  nodeId: string;
  prompt: string;
  context: Record<string, unknown>;
  options?: string[];
};

export type { WaitResume } from './orchestrationNodeExecutors';

/**
 * A node that paused the run to wait for a timer (delay) or the interval
 * between poll attempts. The engine persists this so the background scheduler
 * can resume the run from `nodeId` once `resumeInMs` has elapsed.
 */
export type ScheduledWait = {
  nodeId: string;
  resumeInMs: number;
  resume: WaitResume;
};

// ── Dispatch ──────────────────────────────────────────────────────────────

type DispatchArgs = {
  nodeDefn: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  // 1-based attempt number for a resuming poll node; undefined for a first run.
  pollAttempt?: number;
};

const dispatchSimpleNode = (args: DispatchArgs): NodeExecutionResult | null => {
  const { nodeDefn, state } = args;
  switch (nodeDefn.type) {
    case 'transform':
      return executeTransformNode({ node: nodeDefn, state });
    case 'condition':
      return executeConditionNode({ node: nodeDefn, state });
    case 'human':
      return executeHumanNode({ node: nodeDefn, state });
    case 'webhook':
      return executeWebhookNode({ node: nodeDefn, state });
    default:
      return null;
  }
};

const dispatchNodeExecution = async (
  args: DispatchArgs
): Promise<NodeExecutionResult> => {
  const { nodeDefn, state, projectIds, traceId, authHeader, pollAttempt } =
    args;
  const simple = dispatchSimpleNode(args);
  if (simple !== null) return simple;
  switch (nodeDefn.type) {
    case 'agent':
      return executeAgentNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
    case 'tool':
      return executeToolNode({ node: nodeDefn, state, projectIds, authHeader });
    case 'poll':
      return executePollNode({
        node: nodeDefn,
        state,
        projectIds,
        authHeader,
        attempt: pollAttempt,
      });
    case 'knowledge':
      return executeKnowledgeNode({ node: nodeDefn, state, projectIds });
    case 'memory_write':
      return executeMemoryWriteNode({ node: nodeDefn, state });
    case 'delay':
      return executeDelayNode({ node: nodeDefn });
    case 'loop':
      return executeLoopNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
    case 'sub_orchestration':
      return executeSubOrchestrationNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
    default:
      throw new DomainError(
        'ORCHESTRATION_NODE_FAILED',
        `Unknown node type '${(nodeDefn as OrchestrationNode).type}'.`
      );
  }
};

export const executeNodeById = async (args: {
  nodeId: string;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  pollAttempt?: number;
}): Promise<{
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
}> => {
  const { nodeId, nodes, state, projectIds, traceId, authHeader, pollAttempt } =
    args;
  const nodeDefn = nodes.find((n) => {
    return n.id === nodeId;
  });
  if (!nodeDefn) {
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Node '${nodeId}' not found in orchestration definition.`
    );
  }
  const execResult = await dispatchNodeExecution({
    nodeDefn,
    state,
    projectIds,
    traceId,
    authHeader,
    pollAttempt,
  });
  return { nodeId, nodeDefn, execResult };
};

// ── Batch result processing ───────────────────────────────────────────────

// Activates the successors of a just-completed node, appending newly-activated
// node IDs to `nextRound` (deduped against `activatedNodes`).
const advanceSuccessors = (args: {
  nodeId: string;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  edges: OrchestrationEdge[];
  activatedNodes: Set<string>;
  nextRound: string[];
}): void => {
  const resolved = resolveNextNodes({
    completedNodeId: args.nodeId,
    completedNodes: args.completedNodes,
    conditionLabels: args.conditionLabels,
    edges: args.edges,
  });
  for (const n of resolved) {
    if (!args.activatedNodes.has(n)) {
      args.activatedNodes.add(n);
      args.nextRound.push(n);
    }
  }
};

export const processNodeResultBatch = (args: {
  nodeResults: Array<{
    nodeId: string;
    nodeDefn: OrchestrationNode;
    execResult: NodeExecutionResult;
  }>;
  artifacts: Record<string, unknown>;
  conditionLabels: Map<string, string>;
  completedNodes: Set<string>;
  activatedNodes: Set<string>;
  state: Record<string, unknown>;
  edges: OrchestrationEdge[];
  isRunning: boolean;
}): {
  nextRound: string[];
  requiredAction: RequiredAction | null;
  scheduledWait: ScheduledWait | null;
} => {
  const {
    nodeResults,
    artifacts,
    conditionLabels,
    completedNodes,
    activatedNodes,
    state,
    edges,
    isRunning,
  } = args;

  const nextRound: string[] = [];
  let requiredAction: RequiredAction | null = null;
  let scheduledWait: ScheduledWait | null = null;

  for (const { nodeId, nodeDefn, execResult } of nodeResults) {
    if (execResult.kind === 'requires_action') {
      if (!requiredAction) {
        requiredAction = {
          nodeId: execResult.nodeId,
          prompt: execResult.prompt,
          context: execResult.context,
          options: execResult.options,
        };
      }
      continue;
    }

    if (execResult.kind === 'wait') {
      // The node is not complete — it must be resumed after a timer. Record the
      // first wait and stop advancing; the node stays uncompleted so it (or its
      // successors) resume correctly. Mirrors the single-pause model used for
      // requires_action nodes.
      if (!scheduledWait) {
        scheduledWait = {
          nodeId: execResult.nodeId,
          resumeInMs: execResult.resumeInMs,
          resume: execResult.resume,
        };
      }
      continue;
    }

    if (execResult.kind === 'condition') {
      conditionLabels.set(nodeId, execResult.label);
    } else {
      artifacts[nodeId] = execResult.artifact;
      applyOutputMapping(nodeDefn.outputMapping, execResult.artifact, state);
    }

    completedNodes.add(nodeId);

    if (isRunning && !requiredAction && !scheduledWait) {
      advanceSuccessors({
        nodeId,
        completedNodes,
        conditionLabels,
        edges,
        activatedNodes,
        nextRound,
      });
    }
  }

  return { nextRound, requiredAction, scheduledWait };
};
