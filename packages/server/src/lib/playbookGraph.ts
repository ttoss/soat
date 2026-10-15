import type { PlaybookDefinition, PlaybookNode } from './playbookDefinition';

/** Sources define the edges: a node depends on every node an input reads. */
export const sourcesOf = (args: { node: PlaybookNode }): string[] => {
  const sources = args.node.inputs.flatMap((input) => {
    return input.source === 'manual' ? [] : [input.source.node];
  });

  return [...new Set(sources)];
};

/** First declaration wins, as in validation, which refuses the second. */
export const nodesByKey = (args: {
  definition: PlaybookDefinition;
}): Map<string, PlaybookNode> => {
  const byKey = new Map<string, PlaybookNode>();

  for (const node of args.definition.nodes) {
    if (!byKey.has(node.key)) byKey.set(node.key, node);
  }

  return byKey;
};

type Adjacency = Map<string, { readers: string[]; indegree: number }>;

const adjacencyOf = (args: { definition: PlaybookDefinition }): Adjacency => {
  const byKey = nodesByKey(args);
  const adjacency: Adjacency = new Map(
    [...byKey.keys()].map((key) => {
      return [key, { readers: [], indegree: 0 }];
    })
  );

  for (const node of byKey.values()) {
    for (const source of sourcesOf({ node })) {
      const from = adjacency.get(source);
      const to = adjacency.get(node.key);

      if (!from || !to) continue;

      from.readers.push(node.key);
      to.indegree += 1;
    }
  }

  return adjacency;
};

type Visit = { index: number; low: number };

// Tarjan over the nodes Kahn could not place: empty for a valid definition,
// so recursion depth is bounded by the tangle, not by the playbook.
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
 * Levels of the source DAG, in definition order within a level: a node reads
 * only nodes in earlier waves. A node in or downstream of a cycle is in none.
 */
export const topologicalWaves = (args: {
  definition: PlaybookDefinition;
}): { waves: string[][]; cycles: string[][] } => {
  const adjacency = adjacencyOf(args);
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

/** A node and every node it reads, transitively. */
export const upstreamOf = (args: {
  definition: PlaybookDefinition;
  node: string;
}): Set<string> => {
  const byKey = nodesByKey(args);
  const seen = new Set([args.node]);
  const stack = [args.node];

  for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
    const node = byKey.get(key);

    for (const source of node ? sourcesOf({ node }) : []) {
      if (seen.has(source)) continue;

      seen.add(source);
      stack.push(source);
    }
  }

  return seen;
};
