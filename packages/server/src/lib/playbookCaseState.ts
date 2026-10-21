import { compileJsonSchema } from './jsonSchemaValidator';
import type { PARKING_EXECUTOR_TYPES } from './playbookCaseAutomation';
import type { JsonValue } from './playbookDefinition';
import type {
  PlaybookBasis,
  PlaybookCaseSnapshot,
  PlaybookConforms,
  PlaybookExecutionStatus,
  PlaybookNodeRecord,
  PlaybookRunRef,
} from './playbookState';

/** What the snapshot needs of an entry row, so it reads no model type. */
export type PlaybookEntryFields = {
  revision: number;
  node: string;
  kind: string;
  field: string | null;
  value: unknown;
  basis: object | null;
};

/** What the snapshot needs of an execution row. */
export type PlaybookExecutionFields = {
  node: string;
  status: string;
  result: string | null;
  basis: object;
  executorType: string | null;
  runId: string | null;
};

const RUN_TYPES: Record<
  (typeof PARKING_EXECUTOR_TYPES)[number],
  PlaybookRunRef['type']
> = {
  workflow: 'task',
  orchestration: 'orchestration_run',
};

/** The task or run a running execution started and now waits on. */
const runOf = (
  execution: PlaybookExecutionFields
): PlaybookRunRef | undefined => {
  const type = Object.entries(RUN_TYPES).find(([executorType]) => {
    return executorType === execution.executorType;
  })?.[1];
  return execution.status === 'running' && type && execution.runId
    ? { type, id: execution.runId }
    : undefined;
};

const recordOf = (args: {
  snapshot: PlaybookCaseSnapshot;
  node: string;
}): PlaybookNodeRecord => {
  const record = args.snapshot[args.node] ?? {};
  args.snapshot[args.node] = record;
  return record;
};

/**
 * Folds a case's entries and executions, each oldest first, into the latest
 * value of each field and the latest execution of each node. A rejection holds
 * only while it is newer than the node's last confirmation. An output is
 * current for the basis of the newest execution that settled on it, which
 * moves without a new revision when an execution returns an equal value.
 */
export const snapshotFromRecords = (args: {
  entries: PlaybookEntryFields[];
  executions: PlaybookExecutionFields[];
}): PlaybookCaseSnapshot => {
  const snapshot: PlaybookCaseSnapshot = {};

  for (const entry of args.entries) {
    const record = recordOf({ snapshot, node: entry.node });
    const value = entry.value as JsonValue;
    const basis = entry.basis as PlaybookBasis;
    if (entry.kind === 'input') {
      record.inputs = {
        ...record.inputs,
        [entry.field as string]: { revision: entry.revision, value },
      };
    } else if (entry.kind === 'rejection') {
      record.rejection = { basis };
    } else {
      // An output or a confirmation; a confirmation lifts an earlier rejection.
      record.output = { revision: entry.revision, value, basis };
      delete record.rejection;
    }
  }

  for (const execution of args.executions) {
    const record = recordOf({ snapshot, node: execution.node });
    const basis = execution.basis as PlaybookBasis;
    const run = runOf(execution);
    record.execution = {
      status: execution.status as PlaybookExecutionStatus,
      basis,
      ...(run && { run }),
    };
    if (
      record.output &&
      execution.status === 'completed' &&
      execution.result === 'current'
    ) {
      record.output.basis = basis;
    }
  }

  return snapshot;
};

/**
 * An input's schema as the state reads it. A schema ajv cannot compile is an
 * authoring bug in the playbook, not a bad value, so it admits every value
 * rather than leaving the input forever unset.
 */
export const conformsToInputSchema: PlaybookConforms = (args) => {
  const validate = compileJsonSchema(args.input.schema);
  return validate === null || validate(args.value) === true;
};
