import { compileJsonSchema } from './jsonSchemaValidator';
import type { JsonValue } from './playbookDefinition';
import type {
  PlaybookCaseSnapshot,
  PlaybookConforms,
  PlaybookNodeRecord,
} from './playbookState';

/** What the snapshot needs of an entry row, so it reads no model type. */
export type PlaybookEntryFields = {
  revision: number;
  node: string;
  field: string | null;
  value: unknown;
};

/**
 * Folds a case's input entries, oldest first, into the latest value of each
 * field.
 */
export const snapshotFromEntries = (args: {
  entries: PlaybookEntryFields[];
}): PlaybookCaseSnapshot => {
  const snapshot: PlaybookCaseSnapshot = {};

  for (const entry of args.entries) {
    const record: PlaybookNodeRecord = snapshot[entry.node] ?? {};
    snapshot[entry.node] = record;
    record.inputs = {
      ...record.inputs,
      [entry.field as string]: {
        revision: entry.revision,
        value: entry.value as JsonValue,
      },
    };
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
