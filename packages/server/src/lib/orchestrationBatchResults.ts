import { resolveNextNodes } from './orchestrationGraph';
import { applyStateMapping } from './orchestrationNodeExecutors';
import { writeNodeArtifact } from './orchestrationNodesNamespace';
import type {
  NodeExecutionResult,
  RequiredAction,
  ScheduledWait,
} from './orchestrationNodeTypes';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';

/**
 * What the run loop does with a round of node results: record each completed
 * node, activate its successors, and surface the first pause (a required action
 * or a scheduled wait) that stops the run advancing.
 *
 * Split out of the former `orchestrationExecutors.ts`, which mixed this with
 * node dispatch (see `orchestrationNodeDispatch.ts`) behind a name that
 * described neither.
 */

// Activates the successors of a just-completed node, appending newly-activated
// node IDs to `nextRound` (deduped against `activatedNodes`).
const advanceSuccessors = (args: {
  nodeId: string;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  edges: OrchestrationEdge[];
  activatedNodes: Set<string>;
  nextRound: string[];
  // Nodes whose branch is decided by a label (a guardrail-`blocked` tool node):
  // an unlabeled edge leaving one follows only on the `approved` semantic, i.e.
  // never for a block — so the happy path does not auto-follow a blocked action.
  decisionNodeIds?: Set<string>;
}): void => {
  const resolved = resolveNextNodes({
    completedNodeId: args.nodeId,
    completedNodes: args.completedNodes,
    conditionLabels: args.conditionLabels,
    edges: args.edges,
    decisionNodeIds: args.decisionNodeIds,
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

// A condition contributes its label, recorded under the nodes namespace so a
// validated `nodes.<conditionId>` ref is readable at runtime; every other node
// contributes its artifact plus its `state_mapping` writes.
const recordCompletedNode = (args: {
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: Extract<
    NodeExecutionResult,
    { kind: 'artifact' | 'condition' | 'blocked' }
  >;
  artifacts: Record<string, unknown>;
  conditionLabels: Map<string, string>;
  state: Record<string, unknown>;
}): void => {
  const { nodeId, nodeDefn, execResult, artifacts, conditionLabels, state } =
    args;
  if (execResult.kind === 'condition') {
    conditionLabels.set(nodeId, execResult.label);
    writeNodeArtifact({ nodeId, artifact: { label: execResult.label }, state });
    return;
  }
  if (execResult.kind === 'blocked') {
    // The seeded branch label is what lets `blocked`/`tripwire` edges route.
    // Treated as a decision node at advance time, so unlabeled happy-path edges
    // do not follow.
    conditionLabels.set(nodeId, execResult.label);
    artifacts[nodeId] = execResult.artifact;
    writeNodeArtifact({ nodeId, artifact: execResult.artifact, state });
    applyStateMapping(nodeDefn.stateMapping, execResult.artifact, state);
    return;
  }
  artifacts[nodeId] = execResult.artifact;
  writeNodeArtifact({ nodeId, artifact: execResult.artifact, state });
  applyStateMapping(nodeDefn.stateMapping, execResult.artifact, state);
};

// A guardrail-`blocked` tool node advances as a decision node, so its unlabeled
// happy-path edge never auto-follows.
const settleCompletedNode = (args: {
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: Extract<
    NodeExecutionResult,
    { kind: 'artifact' | 'condition' | 'blocked' }
  >;
  artifacts: Record<string, unknown>;
  conditionLabels: Map<string, string>;
  completedNodes: Set<string>;
  activatedNodes: Set<string>;
  state: Record<string, unknown>;
  edges: OrchestrationEdge[];
  nextRound: string[];
  advance: boolean;
}): void => {
  recordCompletedNode({
    nodeId: args.nodeId,
    nodeDefn: args.nodeDefn,
    execResult: args.execResult,
    artifacts: args.artifacts,
    conditionLabels: args.conditionLabels,
    state: args.state,
  });
  args.completedNodes.add(args.nodeId);
  if (!args.advance) return;
  advanceSuccessors({
    nodeId: args.nodeId,
    completedNodes: args.completedNodes,
    conditionLabels: args.conditionLabels,
    edges: args.edges,
    activatedNodes: args.activatedNodes,
    nextRound: args.nextRound,
    decisionNodeIds:
      args.execResult.kind === 'blocked' ? new Set([args.nodeId]) : undefined,
  });
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
      // The node must resume after a timer, so it stays uncompleted and
      // advancing stops here — the single-pause model `requires_action` uses.
      if (!scheduledWait) {
        scheduledWait = {
          nodeId: execResult.nodeId,
          resumeInMs: execResult.resumeInMs,
          resume: execResult.resume,
        };
      }
      continue;
    }

    settleCompletedNode({
      nodeId,
      nodeDefn,
      execResult,
      artifacts,
      conditionLabels,
      completedNodes,
      activatedNodes,
      state,
      edges,
      nextRound,
      advance: isRunning && !requiredAction && !scheduledWait,
    });
  }

  return { nextRound, requiredAction, scheduledWait, traceId };
};
