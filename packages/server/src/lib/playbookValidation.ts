import {
  parseField,
  type PlaybookDefinition,
  type PlaybookFieldRef,
  type PlaybookNode,
} from './playbookDefinition';
import { nodesByKey, topologicalWaves } from './playbookGraph';
import type { ValidationProblem } from './validationProblems';

export type PlaybookDefinitionProblem = ValidationProblem;

const nodePath = (index: number): string => {
  return `definition.nodes[${index}]`;
};

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
  path: string;
}): PlaybookDefinitionProblem[] => {
  const { id, transformations } = args.node;
  const problems: PlaybookDefinitionProblem[] = [];
  const names = new Set<string>();
  for (const [index, { name }] of (transformations ?? []).entries()) {
    if (names.has(name)) {
      problems.push({
        code: 'DUPLICATE_TRANSFORMATION',
        path: `${args.path}.transformations[${index}].name`,
        message: `Node '${id}' declares transformation '${name}' more than once.`,
      });
    }
    names.add(name);
  }

  return problems;
};

const nodeProblems = (args: {
  node: PlaybookNode;
  path: string;
}): PlaybookDefinitionProblem[] => {
  const { id, kind, executor, transformations, final } = args.node;

  const problems: PlaybookDefinitionProblem[] = [];

  if (kind === 'execute' && !executor) {
    problems.push({
      code: 'EXECUTOR_REQUIRED',
      path: `${args.path}.executor`,
      message: `Execute node '${id}' needs an executor.`,
    });
  }

  if (kind !== 'execute' && executor) {
    problems.push({
      code: 'EXECUTOR_FORBIDDEN',
      path: `${args.path}.executor`,
      message: `${kind} node '${id}' cannot have an executor; only an execute node runs one.`,
    });
  }

  if (transformations?.length && !final) {
    problems.push({
      code: 'TRANSFORMATIONS_NOT_FINAL',
      path: `${args.path}.transformations`,
      message: `Node '${id}' declares transformations but is not final.`,
    });
  }

  problems.push(...transformationProblems(args));

  return problems;
};

const inputProblems = (args: {
  node: PlaybookNode;
  path: string;
  byKey: Map<string, PlaybookNode>;
}): PlaybookDefinitionProblem[] => {
  const { node, byKey } = args;

  const problems: PlaybookDefinitionProblem[] = [];
  const seen = new Set<string>();

  for (const [index, input] of node.inputs.entries()) {
    const path = `${args.path}.inputs[${index}]`;
    const named = `Input '${input.name}' of node '${node.id}'`;

    if (seen.has(input.name)) {
      problems.push({
        code: 'DUPLICATE_INPUT',
        path: `${path}.name`,
        message: `${named} is declared more than once.`,
      });
    }

    seen.add(input.name);

    if (input.source === 'manual') continue;

    const source = byKey.get(input.source.node_id);
    const field = parseField({ field: input.source.field });

    if (!source) {
      problems.push({
        code: 'MISSING_NODE',
        path: `${path}.source.node_id`,
        message: `${named} reads node '${input.source.node_id}', which the definition does not declare.`,
      });
    } else if (!field || !fieldExists({ source, field })) {
      problems.push({
        code: 'UNKNOWN_FIELD',
        path: `${path}.source.field`,
        message: `${named} reads '${input.source.field}', which node '${source.id}' does not produce.`,
      });
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

  for (const [index, node] of definition.nodes.entries()) {
    if (keys.has(node.id)) {
      problems.push({
        code: 'DUPLICATE_NODE',
        path: `${nodePath(index)}.id`,
        message: `Node id '${node.id}' is used by more than one node.`,
      });
    }

    keys.add(node.id);
  }

  for (const [index, node] of definition.nodes.entries()) {
    const path = nodePath(index);
    problems.push(
      ...nodeProblems({ node, path }),
      ...inputProblems({ node, path, byKey })
    );
  }

  for (const nodes of topologicalWaves({ definition }).cycles) {
    const named = nodes
      .map((key) => {
        return `'${key}'`;
      })
      .join(', ');
    problems.push({
      code: 'CYCLE',
      path: 'definition.nodes',
      message: `Nodes ${named} read each other in a cycle.`,
    });
  }

  return problems;
};
