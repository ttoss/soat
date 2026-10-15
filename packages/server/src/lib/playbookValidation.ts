import {
  parseField,
  type PlaybookDefinition,
  type PlaybookFieldRef,
  type PlaybookNode,
} from './playbookDefinition';
import { nodesByKey, topologicalWaves } from './playbookGraph';

export type PlaybookDefinitionProblem =
  | { code: 'duplicate_node'; node: string }
  | { code: 'duplicate_input'; node: string; input: string }
  | { code: 'missing_node'; node: string; input: string }
  | { code: 'unknown_field'; node: string; input: string }
  | { code: 'executor_required'; node: string }
  | { code: 'executor_forbidden'; node: string }
  | { code: 'transformations_not_final'; node: string }
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

const nodeProblems = (args: {
  node: PlaybookNode;
}): PlaybookDefinitionProblem[] => {
  const { key, kind, executor, transformations, final } = args.node;

  const problems: PlaybookDefinitionProblem[] = [];

  if (kind === 'execute' && !executor) {
    problems.push({ code: 'executor_required', node: key });
  }

  if (kind !== 'execute' && executor) {
    problems.push({ code: 'executor_forbidden', node: key });
  }

  if (transformations?.length && !final) {
    problems.push({ code: 'transformations_not_final', node: key });
  }

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
    const at = { node: node.key, input: input.name };

    if (seen.has(input.name)) {
      problems.push({ code: 'duplicate_input', ...at });
    }

    seen.add(input.name);

    if (input.source === 'manual') continue;

    const source = byKey.get(input.source.node);
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
    if (keys.has(node.key)) {
      problems.push({ code: 'duplicate_node', node: node.key });
    }

    keys.add(node.key);
  }

  for (const node of definition.nodes) {
    problems.push(...nodeProblems({ node }), ...inputProblems({ node, byKey }));
  }

  for (const nodes of topologicalWaves({ definition }).cycles) {
    problems.push({ code: 'cycle', nodes });
  }

  return problems;
};
