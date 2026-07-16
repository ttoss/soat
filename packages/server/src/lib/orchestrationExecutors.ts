import { DomainError } from '../errors';
import type { ApprovalNodeSpec } from './orchestrationApprovalNode';
import { executeApprovalNode } from './orchestrationApprovalNode';
import { resolveNextNodes } from './orchestrationGraph';
import type {
  NodeExecutionResult,
  WaitResume,
} from './orchestrationNodeExecutors';
import {
  applyStateMapping,
  executeAgentNode,
  executeConditionNode,
  executeDelayNode,
  executeEmitEventNode,
  executeHumanNode,
  executeKnowledgeNode,
  executeLoopNode,
  executeMemoryWriteNode,
  executeSubOrchestrationNode,
  executeToolNode,
  executeTransformNode,
  executeWebhookNode,
} from './orchestrationNodeExecutors';
import { writeNodeArtifact } from './orchestrationNodesNamespace';
import { executePollNode } from './orchestrationPollNode';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';

export {
  detectCycle,
  detectCycleExcludingLoopNodes,
  findStartNodes,
  resolveNextNodes,
} from './orchestrationGraph';
export type { NodeExecutionResult } from './orchestrationNodeExecutors';
export {
  applyInputMapping,
  applyStateMapping,
} from './orchestrationNodeExecutors';

// ── Types ─────────────────────────────────────────────────────────────────

export type RequiredAction = {
  type: 'human_input' | 'webhook_receive' | 'approval';
  nodeId: string;
  prompt: string;
  context: Record<string, unknown>;
  options?: string[];
  // Carried while the run parks on an `approval` node. `approvalSpec` is the
  // frozen proposal the engine emits as an ApprovalItem at settle time;
  // `approvalId`/`expiresAt` are stamped back on once emitted so the persisted
  // required_action exposes the created item to callers.
  approvalSpec?: ApprovalNodeSpec;
  approvalId?: string;
  expiresAt?: string;
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
  // The run's own project id — used for project-scoped resolution (secrets) and
  // to scope an emit_event node's event to the run's project.
  projectId?: number;
  // The run's public id — used as the resourceId of an emit_event node's event
  // and stamped onto in-run generations' usage events for per-run roll-up.
  runPublicId?: string;
  // The trigger firing (if any) that started the run — propagated onto in-run
  // generations' usage events for in-run trigger attribution.
  triggerId?: string;
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
    case 'approval':
      return executeApprovalNode({ node: nodeDefn, state });
    case 'delay':
      return executeDelayNode({ node: nodeDefn });
    case 'webhook':
      return executeWebhookNode({ node: nodeDefn, state });
    default:
      return null;
  }
};

const dispatchNodeExecution = async (
  args: DispatchArgs
): Promise<NodeExecutionResult> => {
  const {
    nodeDefn,
    state,
    projectIds,
    projectId,
    runPublicId,
    triggerId,
    traceId,
    authHeader,
    pollAttempt,
  } = args;
  const simple = dispatchSimpleNode(args);
  if (simple !== null) return simple;
  switch (nodeDefn.type) {
    case 'emit_event':
      return executeEmitEventNode({
        node: nodeDefn,
        state,
        projectId,
        runPublicId,
      });
    case 'agent':
      return executeAgentNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
        runPublicId,
        triggerId,
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
  projectId?: number;
  runPublicId?: string;
  triggerId?: string;
  traceId: string | null;
  authHeader?: string;
  pollAttempt?: number;
}): Promise<{
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
}> => {
  const {
    nodeId,
    nodes,
    state,
    projectIds,
    projectId,
    runPublicId,
    triggerId,
    traceId,
    authHeader,
    pollAttempt,
  } = args;
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
    projectId,
    runPublicId,
    triggerId,
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

// The first trace produced by a traced node (e.g. an `agent` node) in a batch;
// becomes the run's trace_id when the run has none yet.
const findFirstTraceId = (
  nodeResults: Array<{ execResult: NodeExecutionResult }>
): string | null => {
  for (const { execResult } of nodeResults) {
    if (execResult.kind === 'artifact' && execResult.traceId) {
      return execResult.traceId;
    }
  }
  return null;
};

// Records a completed node's result into the run's shared structures: a
// condition contributes its label (recorded as { label } in the nodes
// namespace so a validated nodes.<conditionId> ref is readable at runtime);
// every other node contributes its artifact plus its state_mapping writes.
const recordCompletedNode = (args: {
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: Extract<NodeExecutionResult, { kind: 'artifact' | 'condition' }>;
  artifacts: Record<string, unknown>;
  conditionLabels: Map<string, string>;
  state: Record<string, unknown>;
}): void => {
  const { nodeId, nodeDefn, execResult, artifacts, conditionLabels, state } =
    args;
  if (execResult.kind === 'condition') {
    conditionLabels.set(nodeId, execResult.label);
    writeNodeArtifact({ nodeId, artifact: { label: execResult.label }, state });
  } else {
    artifacts[nodeId] = execResult.artifact;
    writeNodeArtifact({ nodeId, artifact: execResult.artifact, state });
    applyStateMapping(nodeDefn.stateMapping, execResult.artifact, state);
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
  traceId: string | null;
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
  const traceId = findFirstTraceId(nodeResults);

  for (const { nodeId, nodeDefn, execResult } of nodeResults) {
    if (execResult.kind === 'requires_action') {
      if (!requiredAction) {
        requiredAction = {
          type: execResult.type,
          nodeId: execResult.nodeId,
          prompt: execResult.prompt,
          context: execResult.context,
          options: execResult.options,
          approvalSpec: execResult.approvalSpec,
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

    recordCompletedNode({
      nodeId,
      nodeDefn,
      execResult,
      artifacts,
      conditionLabels,
      state,
    });

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

  return { nextRound, requiredAction, scheduledWait, traceId };
};
