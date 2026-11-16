import type {
  JsonValue,
  PlaybookDefinition,
  PlaybookInput,
  PlaybookNode,
  PlaybookUpstreamRef,
} from './playbookDefinition';
import { nodesByKey, sourcesOf, topologicalWaves } from './playbookGraph';
import { readInputs, type Reads } from './playbookInputReads';
import { resolveRequired } from './playbookRequired';

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
  /** Whether each input is required in this case, by name. */
  resolvedRequired: Record<string, boolean>;
  /** Nodes it reads that must reach `done` first. */
  blockedBy: string[];
  /** Will produce a value without anyone filling an input. */
  settling: boolean;
  /** On an upstream node whose pulled node is `done`: the value a pull writes. */
  pulled?: JsonValue;
};

/** What an upstream node reads of the node it pulls in its bound case. */
export type PlaybookPulledRead = {
  state: PlaybookNodeState;
  settling: boolean;
  output?: PlaybookFieldValue;
};

/** `undefined` for an unbound upstream or a node its bound case lacks. */
export type PlaybookPull = (
  ref: PlaybookUpstreamRef
) => PlaybookPulledRead | undefined;

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

const IN_FLIGHT = new Set<PlaybookExecutionStatus>(['queued', 'running']);

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

/**
 * An upstream node reads the node it pulls, which holds it until `done`. Its
 * first pull is automatic; after that an upstream change leaves it `stale`,
 * never runnable by the cascade, until someone runs it. An unbound name, or a
 * node the bound case's version lacks, reads `blocked`.
 */
/** A pulled node its bound case no longer has leaves nothing to be stale against. */
const upstreamStateOf = (args: {
  record: PlaybookNodeRecord;
  read: PlaybookPulledRead | undefined;
  basis: PlaybookBasis;
  pulled: boolean;
}): PlaybookNodeState => {
  const { record, read, basis, pulled } = args;
  if (read === undefined && !inFlightState({ execution: record.execution })) {
    return 'blocked';
  }
  return stateOf({ record, basis, blocked: !pulled });
};

/** In flight, or unpulled with a value about to be there to pull. */
const upstreamSettles = (args: {
  state: PlaybookNodeState;
  read: PlaybookPulledRead | undefined;
  pulled: boolean;
}): boolean => {
  const { state, read, pulled } = args;
  if (state === 'running' || state === 'waiting') return true;
  if (state !== 'ready' && state !== 'blocked') return false;
  return pulled || read?.settling === true;
};

const upstreamViewOf = (args: {
  node: PlaybookNode;
  ref: PlaybookUpstreamRef;
  snapshot: PlaybookCaseSnapshot;
  pull: PlaybookPull;
}): PlaybookNodeView => {
  const { ref } = args;

  const from = `${ref.name}.${ref.node_id}`;
  const read = args.pull(ref);
  const output = read?.state === 'done' ? read.output : undefined;
  const pulled = output !== undefined;
  const basis: PlaybookBasis = output
    ? { [ref.name]: { from, revision: output.revision } }
    : {};
  const state = upstreamStateOf({
    record: args.snapshot[args.node.id] ?? {},
    read,
    basis,
    pulled,
  });

  return {
    state,
    runnable: state === 'ready',
    basis,
    values: {},
    missing: [],
    resolvedRequired: {},
    blockedBy: pulled ? [] : [from],
    settling: upstreamSettles({ state, read, pulled }),
    ...(output && { pulled: output.value }),
  };
};

const viewOf = (args: {
  node: PlaybookNode;
  snapshot: PlaybookCaseSnapshot;
  views: Map<string, PlaybookNodeView>;
  conforms: PlaybookConforms;
  pull: PlaybookPull;
}): PlaybookNodeView => {
  const { node, snapshot, views } = args;

  if (node.upstream) {
    return upstreamViewOf({ ...args, ref: node.upstream });
  }

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
    resolvedRequired: reads.resolvedRequired,
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
  pull: PlaybookPull;
}): Map<string, PlaybookNodeView> => {
  const { definition, snapshot, conforms, pull } = args;

  const byKey = nodesByKey({ definition });
  const views = new Map<string, PlaybookNodeView>();

  for (const key of topologicalWaves({ definition }).waves.flat()) {
    const node = byKey.get(key);

    if (node) {
      views.set(key, viewOf({ node, snapshot, views, conforms, pull }));
    }
  }

  return new Map(
    [...byKey.values()].map((node) => {
      const view = views.get(node.id) ?? {
        state: 'blocked',
        runnable: false,
        basis: {},
        values: {},
        missing: [],
        resolvedRequired: resolveRequired({ node, values: {} }),
        blockedBy: sourcesOf({ node }),
        settling: false,
      };

      return [node.id, view];
    })
  );
};
