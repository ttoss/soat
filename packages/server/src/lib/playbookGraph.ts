import {
  type Dag,
  topologicalWaves as dagWaves,
  upstreamOf as dagUpstreamOf,
} from './dag';
import type { PlaybookDefinition, PlaybookNode } from './playbookDefinition';

/** Sources define the edges: a node depends on every node an input reads. */
export const sourcesOf = (args: { node: PlaybookNode }): string[] => {
  const sources = args.node.inputs.flatMap((input) => {
    return input.source === 'manual' ? [] : [input.source.node_id];
  });

  return [...new Set(sources)];
};

/** First declaration wins, as in validation, which refuses the second. */
export const nodesByKey = (args: {
  definition: PlaybookDefinition;
}): Map<string, PlaybookNode> => {
  const byKey = new Map<string, PlaybookNode>();

  for (const node of args.definition.nodes) {
    if (!byKey.has(node.id)) byKey.set(node.id, node);
  }

  return byKey;
};

/** The definition as a graph: a node reads every node its inputs name. */
const dagOf = (args: { definition: PlaybookDefinition }): Dag => {
  const byKey = nodesByKey(args);
  return {
    keys: [...byKey.keys()],
    sourcesOf: (key) => {
      const node = byKey.get(key);
      return node ? sourcesOf({ node }) : [];
    },
  };
};

/**
 * Levels of the source DAG, in definition order within a level: a node reads
 * only nodes in earlier waves. A node in or downstream of a cycle is in none.
 */
export const topologicalWaves = (args: {
  definition: PlaybookDefinition;
}): { waves: string[][]; cycles: string[][] } => {
  return dagWaves(dagOf(args));
};

/** A node and every node it reads, transitively. */
export const upstreamOf = (args: {
  definition: PlaybookDefinition;
  node: string;
}): Set<string> => {
  return dagUpstreamOf({ dag: dagOf(args), key: args.node });
};
