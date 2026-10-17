import {
  parseField,
  type PlaybookDefinition,
  type PlaybookFieldRef,
  type PlaybookNode,
} from './playbookDefinition';
import { nodesByKey, topologicalWaves } from './playbookGraph';

export type PlaybookDefinitionProblem =
  | { code: 'duplicate_node'; node_id: string }
  | { code: 'duplicate_input'; node_id: string; input: string }
  | { code: 'missing_node'; node_id: string; input: string }
  | { code: 'unknown_field'; node_id: string; input: string }
  | { code: 'executor_required'; node_id: string }
  | { code: 'executor_forbidden'; node_id: string }
  | { code: 'transformations_not_final'; node_id: string }
  | {
      code: 'duplicate_transformation';
      node_id: string;
      transformation: string;
    }
  | { code: 'cycle'; nodes: string[] };

/** A collect or confirm node's output is its inputs, so its fields are known. */
const fieldExists = (args: {
  source: PlaybookNode;
  field: PlaybookFieldRef;
}): boolean => {
  const { source, field } = args;

  const names = new Set(
    source.inputs.map((input) => {
      return input.name;
    })
  );

  if (field.root === 'input') {
    return names.has(field.name);
  }

  return (
    source.kind === 'execute' ||
    field.path === '' ||
    names.has(field.path.split('.')[0] ?? '')
  );
};

/** A transformation's name is how an export selects it, so it is unique per node. */
const transformationProblems = (args: {
  node: PlaybookNode;
}): PlaybookDefinitionProblem[] => {
  const { id, transformations } = args.node;
  const problems: PlaybookDefinitionProblem[] = [];
  const names = new Set<string>();
  for (const { name } of transformations ?? []) {
    if (names.has(name)) {
      problems.push({
        code: 'duplicate_transformation',
        node_id: id,
        transformation: name,
      });
    }
    names.add(name);
  }

  return problems;
};

const nodeProblems = (args: {
  node: PlaybookNode;
}): PlaybookDefinitionProblem[] => {
  const { id, kind, executor, transformations, final } = args.node;

  const problems: PlaybookDefinitionProblem[] = [];

  if (kind === 'execute' && !executor) {
    problems.push({ code: 'executor_required', node_id: id });
  }

  if (kind !== 'execute' && executor) {
    problems.push({ code: 'executor_forbidden', node_id: id });
  }

  if (transformations?.length && !final) {
    problems.push({ code: 'transformations_not_final', node_id: id });
  }

  problems.push(...transformationProblems({ node: args.node }));

  return problems;
};

const inputProblems = (args: {
  node: PlaybookNode;
  byKey: Map<string, PlaybookNode>;
}): PlaybookDefinitionProblem[] => {
  const { node, byKey } = args;

  const problems: PlaybookDefinitionProblem[] = [];
  const seen = new Set<string>();

  for (const input of node.inputs) {
    const at = { node_id: node.id, input: input.name };

    if (seen.has(input.name)) {
      problems.push({ code: 'duplicate_input', ...at });
    }

    seen.add(input.name);

    if (input.source === 'manual') continue;

    const source = byKey.get(input.source.node_id);
    const field = parseField({ field: input.source.field });

    if (!source) {
      problems.push({ code: 'missing_node', ...at });
    } else if (!field || !fieldExists({ source, field })) {
      problems.push({ code: 'unknown_field', ...at });
    }
  }

  return problems;
};

/**
 * Every reason a definition cannot be stored. The write that creates a version
 * and `validate` both answer from here, so the two cannot disagree.
 */
export const validatePlaybookDefinition = (args: {
  definition: PlaybookDefinition;
}): PlaybookDefinitionProblem[] => {
  const { definition } = args;

  const byKey = nodesByKey({ definition });
  const problems: PlaybookDefinitionProblem[] = [];
  const keys = new Set<string>();

  for (const node of definition.nodes) {
    if (keys.has(node.id)) {
      problems.push({ code: 'duplicate_node', node_id: node.id });
    }

    keys.add(node.id);
  }

  for (const node of definition.nodes) {
    problems.push(...nodeProblems({ node }), ...inputProblems({ node, byKey }));
  }

  for (const nodes of topologicalWaves({ definition }).cycles) {
    problems.push({ code: 'cycle', nodes });
  }

  return problems;
};
