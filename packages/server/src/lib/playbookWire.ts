import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import {
  isPlaybookExportFormat,
  type JsonSchema,
  type JsonValue,
  PLAYBOOK_EXPORT_FORMATS,
  type PlaybookDefinition,
  type PlaybookExecutor,
  type PlaybookExecutorType,
  type PlaybookInput,
  type PlaybookInputSource,
  type PlaybookNode,
  type PlaybookNodeKind,
  type PlaybookTransformation,
} from './playbookDefinition';
import { validatePlaybookDefinition } from './playbookValidation';
import { throwValidationProblems } from './validationProblems';

/**
 * A node id and an input name are JSON Logic `var` path segments and the
 * segments of a source `field`, so neither may hold a dot.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const MAX_NODES = 200;

const MAX_INPUTS = 50;

const NODE_KINDS: ReadonlySet<string> = new Set([
  'collect',
  'execute',
  'confirm',
]);

const EXECUTOR_TYPES: ReadonlySet<string> = new Set([
  'agent',
  'tool',
  'decider',
  'workflow',
  'orchestration',
]);

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim() !== '';
};

const readIdentifier = (args: { path: string; value: unknown }): string => {
  if (typeof args.value !== 'string' || !IDENTIFIER.test(args.value)) {
    throw invalid(
      `${args.path} must start with a letter or underscore and hold only letters, digits and underscores (at most 64).`
    );
  }
  return args.value;
};

const readOptionalString = (args: {
  path: string;
  value: unknown;
}): string | undefined => {
  if (args.value === undefined) return undefined;
  if (typeof args.value !== 'string') {
    throw invalid(`${args.path} must be a string.`);
  }
  return args.value;
};

const readSource = (args: {
  path: string;
  source: unknown;
}): PlaybookInputSource => {
  const { path, source } = args;
  if (source === 'manual') return source;
  if (
    !isPlainObject(source) ||
    !isNonEmptyString(source.node_id) ||
    !isNonEmptyString(source.field)
  ) {
    throw invalid(
      `${path} must be 'manual' or an object naming a node_id and a field.`
    );
  }
  return { node_id: source.node_id, field: source.field };
};

const readInput = (args: { path: string; input: unknown }): PlaybookInput => {
  const { path, input } = args;
  if (!isPlainObject(input)) throw invalid(`${path} must be an object.`);
  if (!isPlainObject(input.schema)) {
    throw invalid(`${path}.schema must be a JSON Schema object.`);
  }
  if (typeof input.required !== 'boolean') {
    throw invalid(`${path}.required must be a boolean.`);
  }
  const description = readOptionalString({
    path: `${path}.description`,
    value: input.description,
  });
  return {
    name: readIdentifier({ path: `${path}.name`, value: input.name }),
    schema: input.schema as JsonSchema,
    required: input.required,
    ...(description !== undefined && { description }),
    source: readSource({ path: `${path}.source`, source: input.source }),
  };
};

const readExecutor = (args: {
  path: string;
  executor: unknown;
}): PlaybookExecutor | undefined => {
  const { path, executor } = args;
  if (executor === undefined) return undefined;
  if (!isPlainObject(executor)) throw invalid(`${path} must be an object.`);
  if (typeof executor.type !== 'string' || !EXECUTOR_TYPES.has(executor.type)) {
    throw invalid(
      `${path}.type must be one of agent, tool, decider, workflow or orchestration.`
    );
  }
  if (!isNonEmptyString(executor.id)) {
    throw invalid(`${path}.id must be a non-empty string.`);
  }
  if (executor.input !== undefined && !isPlainObject(executor.input)) {
    throw invalid(`${path}.input must be an object of JSON Logic expressions.`);
  }
  return {
    type: executor.type as PlaybookExecutorType,
    id: executor.id,
    ...(executor.input !== undefined && {
      // Read off a JSON body, so already a JSON value.
      input: executor.input as Record<string, JsonValue>,
    }),
  };
};

const readTransformations = (args: {
  path: string;
  transformations: unknown;
}): PlaybookTransformation[] | undefined => {
  const { path, transformations } = args;
  if (transformations === undefined) return undefined;
  if (!Array.isArray(transformations)) {
    throw invalid(`${path} must be an array.`);
  }
  return transformations.map((item, index) => {
    const at = `${path}[${index}]`;
    if (!isPlainObject(item)) throw invalid(`${at} must be an object.`);
    if (!isNonEmptyString(item.tool)) {
      throw invalid(`${at}.tool must be a non-empty string.`);
    }
    if (!isPlaybookExportFormat(item.format)) {
      throw invalid(
        `${at}.format must be one of: ${Object.keys(PLAYBOOK_EXPORT_FORMATS).join(', ')}.`
      );
    }
    return {
      name: readIdentifier({ path: `${at}.name`, value: item.name }),
      format: item.format,
      tool: item.tool,
    };
  });
};

/** The node's scalar fields, checked before its collections are read. */
const readNodeHeader = (args: {
  path: string;
  node: unknown;
}): Record<string, unknown> & {
  title: string;
  kind: string;
  inputs: unknown[];
} => {
  const { path, node } = args;
  if (!isPlainObject(node)) throw invalid(`${path} must be an object.`);
  if (!isNonEmptyString(node.title)) {
    throw invalid(`${path}.title must be a non-empty string.`);
  }
  if (typeof node.kind !== 'string' || !NODE_KINDS.has(node.kind)) {
    throw invalid(`${path}.kind must be one of collect, execute or confirm.`);
  }
  if (node.final !== undefined && typeof node.final !== 'boolean') {
    throw invalid(`${path}.final must be a boolean.`);
  }
  if (!Array.isArray(node.inputs) || node.inputs.length > MAX_INPUTS) {
    throw invalid(
      `${path}.inputs must be an array of at most ${MAX_INPUTS} inputs.`
    );
  }
  return { ...node, title: node.title, kind: node.kind, inputs: node.inputs };
};

const readNode = (args: { path: string; node: unknown }): PlaybookNode => {
  const { path } = args;
  const node = readNodeHeader(args);
  const description = readOptionalString({
    path: `${path}.description`,
    value: node.description,
  });
  const executor = readExecutor({
    path: `${path}.executor`,
    executor: node.executor,
  });
  const transformations = readTransformations({
    path: `${path}.transformations`,
    transformations: node.transformations,
  });
  return {
    id: readIdentifier({ path: `${path}.id`, value: node.id }),
    title: node.title,
    ...(description !== undefined && { description }),
    kind: node.kind as PlaybookNodeKind,
    final: node.final === true,
    inputs: node.inputs.map((input, index) => {
      return readInput({ path: `${path}.inputs[${index}]`, input });
    }),
    ...(executor && { executor }),
    ...(transformations && { transformations }),
  };
};

/**
 * Reads a definition from the wire and refuses one the graph core rejects, so
 * a stored definition is always one the core can evaluate. The shape errors
 * are `VALIDATION_FAILED`; the graph's own problems are listed together under
 * `PLAYBOOK_VALIDATION_FAILED`.
 */
export const parsePlaybookDefinition = (args: {
  definition: unknown;
}): PlaybookDefinition => {
  const { definition } = args;
  if (!isPlainObject(definition) || !Array.isArray(definition.nodes)) {
    throw invalid('definition must be an object with a nodes array.');
  }
  if (definition.nodes.length === 0 || definition.nodes.length > MAX_NODES) {
    throw invalid(
      `definition.nodes must hold between 1 and ${MAX_NODES} nodes.`
    );
  }
  return {
    nodes: definition.nodes.map((node, index) => {
      return readNode({ path: `definition.nodes[${index}]`, node });
    }),
  };
};

export const assertPlaybookDefinitionValid = (args: {
  definition: PlaybookDefinition;
}): void => {
  const problems = validatePlaybookDefinition(args);
  if (problems.length > 0) {
    throwValidationProblems({
      code: 'PLAYBOOK_VALIDATION_FAILED',
      subject: 'Playbook definition',
      problems,
      warnings: null,
    });
  }
};
