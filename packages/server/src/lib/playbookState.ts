import { isPlainObject } from './plainObject';
import {
  type JsonValue,
  parseField,
  type PlaybookDefinition,
  type PlaybookFieldRef,
  type PlaybookInput,
  type PlaybookNode,
} from './playbookDefinition';
import { nodesByKey, sourcesOf, topologicalWaves } from './playbookGraph';

/**
 * Revisions are one counter per case, so a revision names one entry: an input
 * that now reads another field can never match its old basis by accident.
 */
export type PlaybookBasisRead = { from: string; revision: number | null };

/** The revision of every input an execution read, by input name. */
export type PlaybookBasis = Record<string, PlaybookBasisRead>;

export type PlaybookFieldValue = { revision: number; value: JsonValue };

export type PlaybookExecutionStatus =
  'queued' | 'running' | 'completed' | 'failed';

/** A workflow task or orchestration run an execution started and waits on. */
export type PlaybookRunRef = { type: 'task' | 'orchestration_run'; id: string };

export type PlaybookNodeRecord = {
  /** Manual inputs, the latest entry of each. */
  inputs?: Record<string, PlaybookFieldValue>;
  /**
   * The latest output. `basis` is the newest one it is known current for: an
   * execution that returned an equal value moves it without a new revision.
   */
  output?: PlaybookFieldValue & { basis: PlaybookBasis };
  /** Present only when the latest decision on a confirm node rejected it. */
  rejection?: { basis: PlaybookBasis };
  /** The latest execution, with the task or run it waits on while it does. */
  execution?: {
    status: PlaybookExecutionStatus;
    basis: PlaybookBasis;
    run?: PlaybookRunRef;
  };
};

/** A case's entries and executions, by node id. */
export type PlaybookCaseSnapshot = Record<string, PlaybookNodeRecord>;

export type PlaybookNodeState =
  | 'blocked'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'done'
  | 'stale'
  | 'failed'
  | 'rejected';

export type PlaybookNodeView = {
  state: PlaybookNodeState;
  /** The cascade starts an execution now. Never true on a confirm node. */
  runnable: boolean;
  basis: PlaybookBasis;
  /** The inputs that are set, by name: what an execution reads. */
  values: Record<string, JsonValue>;
  /** Required inputs that are unset or that their schema refuses. */
  missing: string[];
  /** Nodes it reads that must reach `done` first. */
  blockedBy: string[];
  /** Will produce a value without anyone filling an input. */
  settling: boolean;
};

export type PlaybookConforms = (args: {
  node: PlaybookNode;
  input: PlaybookInput;
  value: JsonValue;
}) => boolean;

export const samePlaybookBasis = (args: {
  left: PlaybookBasis;
  right: PlaybookBasis;
}): boolean => {
  const { left, right } = args;
  const keys = Object.keys(left);

  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      return (
        left[key]?.from === right[key]?.from &&
        left[key]?.revision === right[key]?.revision &&
        key in right
      );
    })
  );
};

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

type Read =
  | { held: true }
  | { held: false; revision: number | null; value: JsonValue | undefined };

const HELD: Read = { held: true };

const UNSET: Read = { held: false, revision: null, value: undefined };

const IN_FLIGHT = new Set<PlaybookExecutionStatus>(['queued', 'running']);

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
  input: PlaybookInput;
  source: { node_id: string; field: string };
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
}): Read => {
  const { input, source, snapshot, views } = args;

  const view = views.get(source.node_id);

  // A required input waits for its node. An optional one waits only for a
  // node about to produce a value; one waiting on a person reads as unset.
  if (view?.state !== 'done') {
    return input.required || view?.settling ? HELD : UNSET;
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
    : readSourced({ input, source: input.source, snapshot, views });
};

const isCurrent = (args: {
  read?: { basis: PlaybookBasis };
  basis: PlaybookBasis;
  blocked: boolean;
}): boolean => {
  const { read, basis, blocked } = args;

  return (
    !blocked &&
    read !== undefined &&
    samePlaybookBasis({ left: read.basis, right: basis })
  );
};

/** `waiting` while it waits on a task or run it started, else `running`. */
const inFlightState = (args: {
  execution: PlaybookNodeRecord['execution'];
}): PlaybookNodeState | undefined => {
  const { execution } = args;
  if (!execution || !IN_FLIGHT.has(execution.status)) return undefined;
  return execution.run ? 'waiting' : 'running';
};

const stateOf = (args: {
  record: PlaybookNodeRecord;
  basis: PlaybookBasis;
  blocked: boolean;
}): PlaybookNodeState => {
  const { record, basis, blocked } = args;
  const { execution, rejection, output } = record;

  const inFlight = inFlightState({ execution });
  if (inFlight) return inFlight;

  if (isCurrent({ read: rejection, basis, blocked })) return 'rejected';

  if (
    execution?.status === 'failed' &&
    isCurrent({ read: execution, basis, blocked })
  ) {
    return 'failed';
  }

  if (output) {
    return isCurrent({ read: output, basis, blocked }) ? 'done' : 'stale';
  }

  return blocked ? 'blocked' : 'ready';
};

type Reads = Pick<PlaybookNodeView, 'basis' | 'values' | 'missing'> & {
  blockedBy: Set<string>;
};

const readInputs = (args: {
  node: PlaybookNode;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
  conforms: PlaybookConforms;
}): Reads => {
  const { node, conforms } = args;

  const reads: Reads = {
    basis: {},
    values: {},
    missing: [],
    blockedBy: new Set(),
  };

  for (const input of node.inputs) {
    const read = readInput({ ...args, input });

    if (read.held) {
      if (input.source !== 'manual') reads.blockedBy.add(input.source.node_id);
      continue;
    }

    reads.basis[input.name] = {
      from:
        input.source === 'manual'
          ? 'manual'
          : `${input.source.node_id}.${input.source.field}`,
      revision: read.revision,
    };

    if (
      read.value !== undefined &&
      conforms({ node, input, value: read.value })
    ) {
      reads.values[input.name] = read.value;
    } else if (input.required) {
      reads.missing.push(input.name);
    }
  }

  return reads;
};

const settles = (args: {
  state: PlaybookNodeState;
  reads: Reads;
  views: Map<string, PlaybookNodeView>;
}): boolean => {
  const { state, reads, views } = args;

  if (state === 'running' || state === 'waiting') return true;

  return (
    (state === 'ready' || state === 'stale') &&
    reads.missing.length === 0 &&
    [...reads.blockedBy].every((key) => {
      return views.get(key)?.settling;
    })
  );
};

const viewOf = (args: {
  node: PlaybookNode;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
  conforms: PlaybookConforms;
}): PlaybookNodeView => {
  const { node, snapshot, views } = args;

  const reads = readInputs(args);
  const blocked = reads.blockedBy.size > 0 || reads.missing.length > 0;
  const state = stateOf({
    record: snapshot[node.id] ?? {},
    basis: reads.basis,
    blocked,
  });

  return {
    state,
    runnable:
      node.kind !== 'confirm' &&
      !blocked &&
      (state === 'ready' || state === 'stale'),
    basis: reads.basis,
    values: reads.values,
    missing: reads.missing,
    blockedBy: [...reads.blockedBy],
    settling: settles({ state, reads, views }),
  };
};

/**
 * Every node's state in one case, computed from its entries and executions and
 * never stored. Nodes are evaluated wave by wave, so a node reads its sources'
 * states; one in or downstream of a cycle is `blocked` on its sources.
 */
export const playbookNodeStates = (args: {
  definition: PlaybookDefinition;
  snapshot: PlaybookCaseSnapshot;
  conforms: PlaybookConforms;
}): Map<string, PlaybookNodeView> => {
  const { definition, snapshot, conforms } = args;

  const byKey = nodesByKey({ definition });
  const views = new Map<string, PlaybookNodeView>();

  for (const key of topologicalWaves({ definition }).waves.flat()) {
    const node = byKey.get(key);

    if (node) views.set(key, viewOf({ node, snapshot, views, conforms }));
  }

  return new Map(
    [...byKey.values()].map((node) => {
      const view = views.get(node.id) ?? {
        state: 'blocked',
        runnable: false,
        basis: {},
        values: {},
        missing: [],
        blockedBy: sourcesOf({ node }),
        settling: false,
      };

      return [node.id, view];
    })
  );
};
