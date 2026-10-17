import createDebug from 'debug';

import { DomainError } from '../errors';
import { compileJsonSchema, describeSchemaErrors } from './jsonSchemaValidator';
import type { OnBehalfOf } from './onBehalfOf';
import { isPlainObject } from './plainObject';
import { advancePlaybookCase } from './playbookCascade';
import {
  appendEntries,
  caseDefinition,
  caseSnapshot,
  type MappedPlaybookCase,
  playbookCases,
  withLockedCase,
} from './playbookCases';
import { answerPlaybookCase } from './playbookCaseWait';
import type {
  JsonValue,
  PlaybookDefinition,
  PlaybookInput,
} from './playbookDefinition';
import { nodesByKey } from './playbookGraph';
import { assertNotOwnWork } from './playbookSelfWrite';
import type { PlaybookCaseSnapshot } from './playbookState';
import { stableDigest } from './stableDigest';

const log = createDebug('soat:playbookCases');

const MAX_INPUTS_PER_WRITE = 100;

export type PlaybookInputWrite = {
  node: string;
  name: string;
  value: unknown;
  /** The revision the writer read; `null` claims the field is still unset. */
  expectedRevision: number | null;
};

const invalidInput = (args: {
  message: string;
  node: string;
  name: string;
}): DomainError => {
  return new DomainError('PLAYBOOK_INPUT_INVALID', args.message, {
    node: args.node,
    input: args.name,
  });
};

/** Reads the batch from the wire; one malformed item refuses the whole call. */
export const parseInputWrites = (raw: unknown): PlaybookInputWrite[] => {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_INPUTS_PER_WRITE
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `inputs must be an array of 1 to ${MAX_INPUTS_PER_WRITE} writes.`
    );
  }
  return raw.map((item, index) => {
    const at = `inputs[${index}]`;
    if (
      !isPlainObject(item) ||
      typeof item.node !== 'string' ||
      typeof item.name !== 'string' ||
      !('value' in item)
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `${at} must name a node, an input and a value.`
      );
    }
    const expected = item.expected_revision;
    if (
      expected !== null &&
      !(typeof expected === 'number' && Number.isInteger(expected))
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `${at}.expected_revision must be the revision read, or null for an unset field.`
      );
    }
    return {
      node: item.node,
      name: item.name,
      value: item.value,
      expectedRevision: expected,
    };
  });
};

/** The manual input a write names, or why it may not be written. */
const manualInput = (args: {
  byKey: ReturnType<typeof nodesByKey>;
  write: PlaybookInputWrite;
}): PlaybookInput => {
  const { node, name } = args.write;
  const input = args.byKey.get(node)?.inputs.find((candidate) => {
    return candidate.name === name;
  });
  if (!input) {
    throw invalidInput({
      message: `The case's playbook version declares no input '${name}' on node '${node}'.`,
      node,
      name,
    });
  }
  if (input.source !== 'manual') {
    throw invalidInput({
      message: `Input '${name}' on node '${node}' reads node '${input.source.node}'; only a manual input is written.`,
      node,
      name,
    });
  }
  const validate = compileJsonSchema(input.schema);
  if (validate !== null && validate(args.write.value) !== true) {
    throw invalidInput({
      message: `Input '${name}' on node '${node}': ${describeSchemaErrors(validate.errors)}`,
      node,
      name,
    });
  }
  return input;
};

/** Every write whose expected revision is not the field's current one. */
const conflictsOf = (args: {
  writes: PlaybookInputWrite[];
  snapshot: PlaybookCaseSnapshot;
}) => {
  return args.writes.flatMap((write) => {
    const current =
      args.snapshot[write.node]?.inputs?.[write.name]?.revision ?? null;
    return current === write.expectedRevision
      ? []
      : [
          {
            node: write.node,
            input: write.name,
            expected_revision: write.expectedRevision,
            current_revision: current,
          },
        ];
  });
};

const assertWritesValid = (args: {
  definition: PlaybookDefinition;
  writes: PlaybookInputWrite[];
}): void => {
  const byKey = nodesByKey({ definition: args.definition });
  const seen = new Set<string>();
  for (const write of args.writes) {
    const field = `${write.node}.${write.name}`;
    if (seen.has(field)) {
      throw invalidInput({
        message: `Input '${write.name}' on node '${write.node}' is written twice in one call.`,
        node: write.node,
        name: write.name,
      });
    }
    seen.add(field);
    manualInput({ byKey, write });
  }
};

/**
 * Writes a batch of manual inputs, all or none. Each write names the revision
 * it read, so a field someone wrote since is refused rather than overwritten;
 * a value equal to the current one writes no revision.
 */
export const writePlaybookCaseInputs = async (args: {
  projectIds?: number[];
  id: string;
  writes: PlaybookInputWrite[];
  createdByUserId: number | null;
  onBehalfOf: OnBehalfOf | null;
  runWorkPublicId?: string;
  wait?: boolean;
}): Promise<MappedPlaybookCase> => {
  log('writePlaybookCaseInputs: id=%s count=%d', args.id, args.writes.length);
  const found = await playbookCases.getByPublicId(args);
  await assertNotOwnWork({
    caseDbId: found.id as number,
    casePublicId: found.publicId,
    runWorkPublicId: args.runWorkPublicId,
  });
  const definition = await caseDefinition({ row: found });
  assertWritesValid({ definition, writes: args.writes });

  await withLockedCase({
    row: found,
    work: async ({ locked, transaction }) => {
      const snapshot = await caseSnapshot({
        caseDbId: locked.id as number,
        transaction,
      });
      const conflicts = conflictsOf({ writes: args.writes, snapshot });
      if (conflicts.length > 0) {
        throw new DomainError(
          'PLAYBOOK_INPUT_CONFLICT',
          `${conflicts.length} input(s) changed since they were read.`,
          { conflicts }
        );
      }

      await appendEntries({
        locked,
        transaction,
        entries: args.writes
          .filter((write) => {
            const current = snapshot[write.node]?.inputs?.[write.name];
            return (
              !current ||
              stableDigest(current.value) !== stableDigest(write.value)
            );
          })
          .map((write) => {
            return {
              node: write.node,
              kind: 'input' as const,
              field: write.name,
              value: write.value as JsonValue,
              basis: null,
              playbookVersion: locked.playbookVersion,
              createdByUserId: args.createdByUserId,
              onBehalfOf: args.onBehalfOf,
            };
          }),
      });
    },
  });

  await advancePlaybookCase({ caseDbId: found.id as number });
  return answerPlaybookCase({ row: found, wait: args.wait === true });
};
