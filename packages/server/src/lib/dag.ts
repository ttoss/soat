/**
 * A directed graph by its keys, in declaration order, and the sources each key
 * reads: a key comes after every source it names. A source that is not a key
 * is no edge — naming one is a reference error each caller reports in its own
 * terms. A repeated key keeps its first declaration.
 */
export type Dag = {
  keys: readonly string[];
  sourcesOf: (key: string) => readonly string[];
};

type Adjacency = Map<string, { readers: string[]; indegree: number }>;

const adjacencyOf = (dag: Dag): Adjacency => {
  const adjacency: Adjacency = new Map();

  for (const key of dag.keys) {
    if (!adjacency.has(key)) adjacency.set(key, { readers: [], indegree: 0 });
  }

  for (const key of adjacency.keys()) {
    for (const source of new Set(dag.sourcesOf(key))) {
      const from = adjacency.get(source);
      const to = adjacency.get(key);

      if (!from || !to) continue;

      from.readers.push(key);
      to.indegree += 1;
    }
  }

  return adjacency;
};

type Visit = { index: number; low: number };

// Tarjan over the keys Kahn could not place: empty for an acyclic graph, so
// recursion depth is bounded by the tangle, not by the graph.
const cyclesOf = (args: {
  residual: string[];
  adjacency: Adjacency;
}): string[][] => {
  const { residual, adjacency } = args;

  const scope = new Set(residual);
  const visits = new Map<string, Visit>();
  const stack: string[] = [];
  const components: string[][] = [];

  const readersOf = (key: string): string[] => {
    return (adjacency.get(key)?.readers ?? []).filter((reader) => {
      return scope.has(reader);
    });
  };

  const visit = (key: string): Visit => {
    const own: Visit = { index: visits.size, low: visits.size };

    visits.set(key, own);
    stack.push(key);

    for (const reader of readersOf(key)) {
      const seen = visits.get(reader);

      if (!seen) {
        own.low = Math.min(own.low, visit(reader).low);
      } else if (stack.includes(reader)) {
        own.low = Math.min(own.low, seen.index);
      }
    }

    if (own.low !== own.index) return own;

    const component = stack.splice(stack.indexOf(key));

    if (component.length > 1 || readersOf(key).includes(key)) {
      components.push(
        residual.filter((member) => {
          return component.includes(member);
        })
      );
    }

    return own;
  };

  for (const key of residual) {
    if (!visits.has(key)) visit(key);
  }

  return components.sort((left, right) => {
    return residual.indexOf(left[0] ?? '') - residual.indexOf(right[0] ?? '');
  });
};

/**
 * Levels of the graph, in declaration order within a level: a key reads only
 * keys in earlier waves. A key in or downstream of a cycle is in no wave;
 * `cycles` names each cycle's members, in declaration order.
 */
export const topologicalWaves = (
  dag: Dag
): { waves: string[][]; cycles: string[][] } => {
  const adjacency = adjacencyOf(dag);
  const keys = [...adjacency.keys()];
  const byPosition = (left: string, right: string): number => {
    return keys.indexOf(left) - keys.indexOf(right);
  };

  const waves: string[][] = [];
  const placed = new Set<string>();

  let frontier = keys.filter((key) => {
    return adjacency.get(key)?.indegree === 0;
  });

  while (frontier.length > 0) {
    waves.push(frontier);

    const next: string[] = [];

    for (const key of frontier) {
      placed.add(key);

      for (const reader of adjacency.get(key)?.readers ?? []) {
        const node = adjacency.get(reader);

        if (!node) continue;

        node.indegree -= 1;

        if (node.indegree === 0) next.push(reader);
      }
    }

    frontier = next.sort(byPosition);
  }

  const residual = keys.filter((key) => {
    return !placed.has(key);
  });

  return { waves, cycles: cyclesOf({ residual, adjacency }) };
};

/** A key and every key it reads, transitively. */
export const upstreamOf = (args: { dag: Dag; key: string }): Set<string> => {
  const seen = new Set([args.key]);
  const stack = [args.key];

  for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
    for (const source of args.dag.sourcesOf(key)) {
      if (seen.has(source)) continue;

      seen.add(source);
      stack.push(source);
    }
  }

  return seen;
};
