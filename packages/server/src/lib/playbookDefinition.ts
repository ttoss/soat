export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type PlaybookNodeKind = 'collect' | 'execute' | 'confirm';

export type PlaybookExecutorType =
  'agent' | 'tool' | 'decider' | 'workflow' | 'orchestration';

export type JsonSchema = { [key: string]: JsonValue };

/** `field` is `output[.path]` or `input.<name>[.path]` of the node named. */
export type PlaybookInputSource = 'manual' | { node: string; field: string };

export type PlaybookInput = {
  name: string;
  schema: JsonSchema;
  required: boolean;
  description?: string;
  source: PlaybookInputSource;
};

export type PlaybookExecutor = {
  type: PlaybookExecutorType;
  id: string;
  /** JSON Logic over the node's inputs, as an orchestration's `input_mapping`. */
  input?: Record<string, JsonValue>;
};

export type PlaybookTransformation = {
  name: string;
  format: string;
  tool: string;
};

export type PlaybookNode = {
  /** Stable across versions: a case's values carry over by key. */
  key: string;
  title: string;
  description?: string;
  kind: PlaybookNodeKind;
  final: boolean;
  inputs: PlaybookInput[];
  executor?: PlaybookExecutor;
  transformations?: PlaybookTransformation[];
};

export type PlaybookDefinition = { nodes: PlaybookNode[] };

export type PlaybookFieldRef =
  | { root: 'output'; path: string }
  | { root: 'input'; name: string; path: string };

export const parseField = (args: {
  field: string;
}): PlaybookFieldRef | undefined => {
  const [root, ...rest] = args.field.split('.');

  if (root === 'output') {
    return { root, path: rest.join('.') };
  }

  const [name, ...path] = rest;

  if (root === 'input' && name) {
    return { root, name, path: path.join('.') };
  }

  return undefined;
};
