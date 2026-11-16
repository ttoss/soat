import { isPlainObject } from './plainObject';
import {
  type JsonValue,
  parseField,
  type PlaybookFieldRef,
  type PlaybookInput,
  type PlaybookNode,
} from './playbookDefinition';
import { resolveRequired } from './playbookRequired';
import type {
  PlaybookBasisRead,
  PlaybookCaseSnapshot,
  PlaybookConforms,
  PlaybookFieldValue,
  PlaybookNodeView,
} from './playbookState';

/** The value at a dotted path; `''` is the value itself. */
const valueAt = (args: {
  value: JsonValue | undefined;
  path: string;
}): JsonValue | undefined => {
  if (args.path === '') return args.value;

  let current = args.value;

  for (const segment of args.path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }

  return current;
};

/** `awaiting`: a source neither `done` nor settling, which holds a required input. */
type Read =
  | { held: true }
  | { held: 'awaiting' }
  | { held: false; revision: number | null; value: JsonValue | undefined };

const HELD: Read = { held: true };

const AWAITING: Read = { held: 'awaiting' };

const UNSET: Read = { held: false, revision: null, value: undefined };

const readManual = (args: { field?: PlaybookFieldValue }): Read => {
  const { field } = args;

  return field
    ? { held: false, revision: field.revision, value: field.value }
    : UNSET;
};

const readField = (args: {
  field: PlaybookFieldRef;
  view: PlaybookNodeView;
  output?: PlaybookFieldValue;
}): Read => {
  const { field, view, output } = args;

  if (field.root === 'input') {
    const read = view.basis[field.name];

    return {
      held: false,
      revision: read ? read.revision : null,
      value: valueAt({ value: view.values[field.name], path: field.path }),
    };
  }

  return output
    ? {
        held: false,
        revision: output.revision,
        value: valueAt({ value: output.value, path: field.path }),
      }
    : UNSET;
};

const readSourced = (args: {
  source: { node_id: string; field: string };
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
}): Read => {
  const { source, snapshot, views } = args;

  const view = views.get(source.node_id);

  // A required input waits for its node. An optional one waits only for a
  // node about to produce a value; one waiting on a person reads as unset.
  if (view?.state !== 'done') {
    return view?.settling ? HELD : AWAITING;
  }

  const field = parseField({ field: source.field });

  return field
    ? readField({ field, view, output: snapshot[source.node_id]?.output })
    : UNSET;
};

const readInput = (args: {
  node: PlaybookNode;
  input: PlaybookInput;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
}): Read => {
  const { node, input, snapshot, views } = args;

  return input.source === 'manual'
    ? readManual({ field: snapshot[node.id]?.inputs?.[input.name] })
    : readSourced({ source: input.source, snapshot, views });
};

export type Reads = Pick<
  PlaybookNodeView,
  'basis' | 'values' | 'missing' | 'resolvedRequired'
> & {
  blockedBy: Set<string>;
};

/** Every input's read, and the values among them that their schema accepts. */
const readValues = (args: {
  node: PlaybookNode;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
  conforms: PlaybookConforms;
}): { entries: Read[]; values: Record<string, JsonValue> } => {
  const { node, conforms } = args;

  const entries: Read[] = [];
  const values: Record<string, JsonValue> = {};

  for (const input of node.inputs) {
    const entry = readInput({ ...args, input });
    entries.push(entry);
    if (
      entry.held === false &&
      entry.value !== undefined &&
      conforms({ node, input, value: entry.value })
    ) {
      values[input.name] = entry.value;
    }
  }

  return { entries, values };
};

const isHeld = (args: { entry: Read; needed: boolean }): boolean => {
  return (
    args.entry.held === true || (args.entry.held === 'awaiting' && args.needed)
  );
};

const basisReadOf = (args: {
  input: PlaybookInput;
  entry: Read;
}): PlaybookBasisRead => {
  const { input, entry } = args;

  return {
    from:
      input.source === 'manual'
        ? 'manual'
        : `${input.source.node_id}.${input.source.field}`,
    revision: entry.held === false ? entry.revision : null,
  };
};

/**
 * Two passes: every input's value is read first, then `required` is resolved
 * once over the values that conform, and only then decides held and missing.
 */
export const readInputs = (args: {
  node: PlaybookNode;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
  conforms: PlaybookConforms;
}): Reads => {
  const { node } = args;

  const { entries, values } = readValues(args);
  const required = resolveRequired({ node, values });
  const reads: Reads = {
    basis: {},
    values,
    missing: [],
    resolvedRequired: required,
    blockedBy: new Set(),
  };

  for (const [index, input] of node.inputs.entries()) {
    const entry = entries[index];

    if (isHeld({ entry, needed: required[input.name] })) {
      if (input.source !== 'manual') reads.blockedBy.add(input.source.node_id);
      continue;
    }

    reads.basis[input.name] = basisReadOf({ input, entry });

    if (!Object.hasOwn(values, input.name) && required[input.name]) {
      reads.missing.push(input.name);
    }
  }

  return reads;
};
