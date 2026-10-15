import { compileJsonSchema } from './jsonSchemaValidator';
import type { JsonValue } from './playbookDefinition';
import type {
  PlaybookBasis,
  PlaybookCaseSnapshot,
  PlaybookConforms,
  PlaybookExecutionStatus,
  PlaybookNodeRecord,
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
 * value of each field and the latest execution of each node. An output is
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
    if (entry.kind === 'output') {
      record.output = {
        revision: entry.revision,
        value,
        basis: entry.basis as PlaybookBasis,
      };
    } else {
      record.inputs = {
        ...record.inputs,
        [entry.field as string]: { revision: entry.revision, value },
      };
    }
  }

  for (const execution of args.executions) {
    const record = recordOf({ snapshot, node: execution.node });
    const basis = execution.basis as PlaybookBasis;
    record.execution = {
      status: execution.status as PlaybookExecutionStatus,
      basis,
    };
    if (
      record.output &&
      execution.status === 'succeeded' &&
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
