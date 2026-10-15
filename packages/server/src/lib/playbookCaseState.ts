import { compileJsonSchema } from './jsonSchemaValidator';
import type { JsonValue } from './playbookDefinition';
import type {
  PlaybookBasis,
  PlaybookCaseSnapshot,
  PlaybookConforms,
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

/**
 * Folds a case's entries, oldest first, into the latest value of each field.
 * A confirmation is the node's output; a rejection holds only while it is
 * newer than the node's last confirmation.
 */
export const snapshotFromEntries = (args: {
  entries: PlaybookEntryFields[];
}): PlaybookCaseSnapshot => {
  const snapshot: PlaybookCaseSnapshot = {};

  for (const entry of args.entries) {
    const record: PlaybookNodeRecord = snapshot[entry.node] ?? {};
    snapshot[entry.node] = record;
    const value = entry.value as JsonValue;
    const basis = (entry.basis ?? {}) as PlaybookBasis;

    if (entry.kind === 'input' && entry.field !== null) {
      record.inputs = {
        ...record.inputs,
        [entry.field]: { revision: entry.revision, value },
      };
    } else if (entry.kind === 'output' || entry.kind === 'confirmation') {
      record.output = { revision: entry.revision, value, basis };
      delete record.rejection;
    } else if (entry.kind === 'rejection') {
      record.rejection = { basis };
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
