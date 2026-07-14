import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';

const detectCycleDfs = (args: {
  nodeId: string;
  edges: OrchestrationEdge[];
  visited: Set<string>;
  inStack: Set<string>;
}): boolean => {
  const { nodeId, edges, visited, inStack } = args;
  visited.add(nodeId);
  inStack.add(nodeId);

  for (const edge of edges) {
    if (edge.from !== nodeId) continue;
    if (!visited.has(edge.to)) {
      if (detectCycleDfs({ nodeId: edge.to, edges, visited, inStack }))
        return true;
    } else if (inStack.has(edge.to)) {
      return true;
    }
  }

  inStack.delete(nodeId);
  return false;
};

export const detectCycle = (
  nodes: OrchestrationNode[],
  edges: OrchestrationEdge[]
): boolean => {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (detectCycleDfs({ nodeId: node.id, edges, visited, inStack }))
        return true;
    }
  }

  return false;
};

/**
 * Detects a cycle while ignoring `loop` nodes, which legitimately introduce
 * intentional iteration via a sub-orchestration rather than a graph cycle.
 * Excluding only `loop` nodes (and edges touching them) — rather than
 * skipping cycle detection entirely whenever one is present — still catches
 * a genuine, unrelated cycle among the remaining nodes.
 */
export const detectCycleExcludingLoopNodes = (
  nodes: OrchestrationNode[],
  edges: OrchestrationEdge[]
): boolean => {
  const loopNodeIds = new Set(
    nodes
      .filter((n) => {
        return n.type === 'loop';
      })
      .map((n) => {
        return n.id;
      })
  );
  if (loopNodeIds.size === 0) return detectCycle(nodes, edges);

  const nonLoopNodes = nodes.filter((n) => {
    return !loopNodeIds.has(n.id);
  });
  const nonLoopEdges = edges.filter((e) => {
    return !loopNodeIds.has(e.from) && !loopNodeIds.has(e.to);
  });
  return detectCycle(nonLoopNodes, nonLoopEdges);
};

export const findStartNodes = (
  nodes: OrchestrationNode[],
  edges: OrchestrationEdge[]
): string[] => {
  const hasIncoming = new Set(
    edges.map((e) => {
      return e.to;
    })
  );
  return nodes
    .map((n) => {
      return n.id;
    })
    .filter((id) => {
      return !hasIncoming.has(id);
    });
};

/**
 * Whether an edge's branch condition is met. A `condition` edge follows only
 * when the completed node's label matches. An unlabeled edge leaving a decision
 * node (`approval`) follows only on the `approved` label; otherwise unlabeled
 * edges always follow.
 */
const edgeConditionMet = (args: {
  edge: OrchestrationEdge;
  label: string | undefined;
  isDecisionNode: boolean;
}): boolean => {
  const { edge, label, isDecisionNode } = args;
  if (edge.condition !== undefined) return label === edge.condition;
  if (isDecisionNode) return label === 'approved';
  return true;
};

/**
 * For an `all`-activation edge, whether every edge in its activation group has
 * a completed source (a join barrier). Non-grouped edges always pass.
 */
const activationGroupSatisfied = (args: {
  edge: OrchestrationEdge;
  edges: OrchestrationEdge[];
  completedNodes: Set<string>;
}): boolean => {
  const { edge, edges, completedNodes } = args;
  if (!edge.activationGroup || edge.activationCondition !== 'all') return true;
  return edges
    .filter((e) => {
      return e.to === edge.to && e.activationGroup === edge.activationGroup;
    })
    .every((e) => {
      return completedNodes.has(e.from);
    });
};

export const resolveNextNodes = (args: {
  completedNodeId: string;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  edges: OrchestrationEdge[];
  // Nodes whose branch is decided by a decision label (`approval`). An unlabeled
  // edge leaving one of these follows only when the label is `approved` — the
  // rejection/expiry paths must be modeled with explicit `condition` edges.
  decisionNodeIds?: Set<string>;
}): string[] => {
  const { completedNodeId, completedNodes, conditionLabels, edges } = args;
  const isDecisionNode = args.decisionNodeIds?.has(completedNodeId) ?? false;
  const label = conditionLabels.get(completedNodeId);

  const next = edges
    .filter((edge) => {
      return (
        edge.from === completedNodeId &&
        edgeConditionMet({ edge, label, isDecisionNode }) &&
        activationGroupSatisfied({ edge, edges, completedNodes })
      );
    })
    .map((edge) => {
      return edge.to;
    });

  return [...new Set(next)];
};
