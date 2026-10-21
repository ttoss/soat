export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type PlaybookNodeKind = 'collect' | 'execute' | 'confirm' | 'upstream';

export type PlaybookExecutorType =
  'agent' | 'tool' | 'decider' | 'workflow' | 'orchestration';

export type JsonSchema = { [key: string]: JsonValue };

/** `field` is `output[.path]` or `input.<name>[.path]` of the node named. */
export type PlaybookInputSource = 'manual' | { node_id: string; field: string };

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
  /** A `tool` executor's action on a multi-action (`mcp`, `soat`) tool. */
  operation_id?: string;
  /** JSON Logic over the node's inputs, as an orchestration's `input_mapping`. */
  input?: Record<string, JsonValue>;
};

/** The content type an export of each format must carry. */
export const PLAYBOOK_EXPORT_FORMATS = {
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export type PlaybookExportFormat = keyof typeof PLAYBOOK_EXPORT_FORMATS;

export const isPlaybookExportFormat = (
  value: unknown
): value is PlaybookExportFormat => {
  return (
    typeof value === 'string' && Object.hasOwn(PLAYBOOK_EXPORT_FORMATS, value)
  );
};

export type PlaybookTransformation = {
  name: string;
  format: PlaybookExportFormat;
  tool: string;
};

/** Another playbook of the project a case of this one binds a case of. */
export type PlaybookUpstream = { name: string; playbook_id: string };

/** The node of the bound upstream case an `upstream` node pulls. */
export type PlaybookUpstreamRef = { name: string; node_id: string };

export type PlaybookNode = {
  /** Stable across versions: a case's values carry over by id. */
  id: string;
  title: string;
  description?: string;
  kind: PlaybookNodeKind;
  final: boolean;
  inputs: PlaybookInput[];
  executor?: PlaybookExecutor;
  /** Only on an `upstream` node, which has no inputs and no executor. */
  upstream?: PlaybookUpstreamRef;
  transformations?: PlaybookTransformation[];
};

/** `upstreams` is absent, never empty, so a definition without one is unchanged. */
export type PlaybookDefinition = {
  upstreams?: PlaybookUpstream[];
  nodes: PlaybookNode[];
};

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
