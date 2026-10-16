import { topologicalOrder } from './orchestrationGraph';
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
