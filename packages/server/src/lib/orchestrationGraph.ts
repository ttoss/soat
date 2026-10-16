import { type Dag, topologicalWaves } from './dag';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';

/** The orchestration as a graph: a node reads every node with an edge into it. */
const dagOf = (args: { keys: string[]; edges: OrchestrationEdge[] }): Dag => {
  const sources = new Map<string, string[]>();
  for (const edge of args.edges) {
    sources.set(edge.to, [...(sources.get(edge.to) ?? []), edge.from]);
  }
  return {
    keys: args.keys,
    sourcesOf: (key) => {
      return sources.get(key) ?? [];
    },
  };
};

/**
 * Every cycle in the graph, ignoring `loop` nodes, which introduce iteration
 * through a sub-orchestration rather than a graph cycle. Only `loop` nodes and
 * the edges touching them are excluded, so a genuine, unrelated cycle among
 * the remaining nodes is still found.
 */
export const cyclesExcludingLoopNodes = (
  nodes: OrchestrationNode[],
  edges: OrchestrationEdge[]
): string[][] => {
  const loopNodeIds = new Set(
    nodes
      .filter((n) => {
        return n.type === 'loop';
      })
      .map((n) => {
        return n.id;
      })
  );
  return topologicalWaves(
    dagOf({
      keys: nodes
        .map((n) => {
          return n.id;
        })
        .filter((id) => {
          return !loopNodeIds.has(id);
        }),
      edges: edges.filter((e) => {
        return !loopNodeIds.has(e.from) && !loopNodeIds.has(e.to);
      }),
    })
  ).cycles;
};

/** The message naming each cycle, as validation and the run loop report it. */
export const describeCycles = (cycles: string[][]): string => {
  return `Cycle detected in orchestration graph: ${cycles
    .map((cycle) => {
      return cycle.join(', ');
    })
    .join('; ')}.`;
};

/** A topological order of the nodes, for a graph with no cycle. */
export const topologicalOrder = (args: {
  nodeIds: string[];
  edges: OrchestrationEdge[];
}): string[] => {
  return topologicalWaves(
    dagOf({ keys: args.nodeIds, edges: args.edges })
  ).waves.flat();
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
 * For a grouped edge, whether every edge in its activation group has a
 * completed source (a join barrier). `all` is the default: only `any` lets a
 * grouped edge pass on its own. Non-grouped edges always pass.
 */
const activationGroupSatisfied = (args: {
  edge: OrchestrationEdge;
  edges: OrchestrationEdge[];
  completedNodes: Set<string>;
}): boolean => {
  const { edge, edges, completedNodes } = args;
  if (!edge.activationGroup || edge.activationCondition === 'any') return true;
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
