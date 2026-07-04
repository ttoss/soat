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

export const resolveNextNodes = (args: {
  completedNodeId: string;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  edges: OrchestrationEdge[];
}): string[] => {
  const { completedNodeId, completedNodes, conditionLabels, edges } = args;
  const next: string[] = [];

  const outEdges = edges.filter((e) => {
    return e.from === completedNodeId;
  });

  for (const edge of outEdges) {
    if (edge.condition !== undefined) {
      const label = conditionLabels.get(completedNodeId);
      if (label !== edge.condition) continue;
    }

    if (edge.activationGroup && edge.activationCondition === 'all') {
      const groupEdges = edges.filter((e) => {
        return e.to === edge.to && e.activationGroup === edge.activationGroup;
      });
      const allSatisfied = groupEdges.every((e) => {
        return completedNodes.has(e.from);
      });
      if (!allSatisfied) continue;
    }

    next.push(edge.to);
  }

  return [...new Set(next)];
};
