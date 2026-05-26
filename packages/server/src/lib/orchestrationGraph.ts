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
