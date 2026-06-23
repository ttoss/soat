import type { OrchestrationEdge } from './orchestrations';

// ── Graph traversal ───────────────────────────────────────────────────────

export const buildPredecessors = (
  edges: OrchestrationEdge[]
): Map<string, string[]> => {
  const preds = new Map<string, string[]>();
  for (const edge of edges) {
    const list = preds.get(edge.to) ?? [];
    list.push(edge.from);
    preds.set(edge.to, list);
  }
  return preds;
};

/** All transitive predecessors of `nodeId` (excluding the node itself). */
export const transitivePredecessors = (args: {
  nodeId: string;
  preds: Map<string, string[]>;
}): Set<string> => {
  const { nodeId, preds } = args;
  const seen = new Set<string>();
  const stack = [...(preds.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const p of preds.get(current) ?? []) stack.push(p);
  }
  return seen;
};

const buildGraphIndexes = (args: {
  nodeIds: string[];
  edges: OrchestrationEdge[];
}): { indegree: Map<string, number>; adjacency: Map<string, string[]> } => {
  const { nodeIds, edges } = args;
  const idSet = new Set(nodeIds);
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) indegree.set(id, 0);
  for (const edge of edges) {
    if (!idSet.has(edge.to) || !idSet.has(edge.from)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  return { indegree, adjacency };
};

/** Kahn's algorithm — a topological ordering of the (acyclic) graph. */
const topologicalOrder = (args: {
  nodeIds: string[];
  edges: OrchestrationEdge[];
}): string[] => {
  const { nodeIds, edges } = args;
  const { indegree, adjacency } = buildGraphIndexes({ nodeIds, edges });
  const queue = nodeIds.filter((id) => {
    return (indegree.get(id) ?? 0) === 0;
  });
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    order.push(current);
    for (const next of adjacency.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return order;
};

const intersectSets = (a: Set<string>, b: Set<string>): Set<string> => {
  return new Set(
    [...a].filter((x) => {
      return b.has(x);
    })
  );
};

/**
 * Dominator set per node on an acyclic graph. A node `d` dominates `n` when
 * every path from a start node to `n` passes through `d`. Computed in
 * topological order: `dom(n) = {n} ∪ ⋂ dom(p)` over all predecessors `p`.
 */
export const computeDominators = (args: {
  nodeIds: string[];
  edges: OrchestrationEdge[];
  preds: Map<string, string[]>;
}): Map<string, Set<string>> => {
  const { nodeIds, edges, preds } = args;
  const idSet = new Set(nodeIds);
  const order = topologicalOrder({ nodeIds, edges });

  const dom = new Map<string, Set<string>>();
  for (const id of order) {
    const nodePreds = (preds.get(id) ?? []).filter((p) => {
      return idSet.has(p);
    });
    let intersection: Set<string> | null = null;
    for (const p of nodePreds) {
      const pDom = dom.get(p);
      if (!pDom) continue;
      intersection =
        intersection === null
          ? new Set(pDom)
          : intersectSets(intersection, pDom);
    }
    const result = intersection ?? new Set<string>();
    result.add(id);
    dom.set(id, result);
  }
  return dom;
};
