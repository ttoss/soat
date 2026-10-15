import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { compileJsonSchema, describeSchemaErrors } from './jsonSchemaValidator';
import { isPlainObject } from './plainObject';
import { advancePlaybookCase } from './playbookCascade';
import {
  caseDefinition,
  caseSnapshot,
  type MappedPlaybookCase,
  mapPlaybookCase,
  playbookCases,
} from './playbookCases';
import type { PlaybookDefinition, PlaybookInput } from './playbookDefinition';
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
  runWorkPublicId?: string;
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

  await db.sequelize.transaction(async (transaction) => {
    // The row lock serializes writers on one case, so the revision counter and
    // the conflict check read what the previous writer committed.
    const locked = await db.PlaybookCase.findOne({
      where: { id: found.id as number },
      lock: transaction.LOCK.UPDATE,
      transaction,
      rejectOnEmpty: playbookCases.notFound(args.id),
    });

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

    let revision = locked.revision;
    for (const write of args.writes) {
      const current = snapshot[write.node]?.inputs?.[write.name];
      if (
        current &&
        stableDigest(current.value) === stableDigest(write.value)
      ) {
        continue;
      }
      revision += 1;
      await db.PlaybookEntry.create(
        {
          caseId: locked.id as number,
          revision,
          node: write.node,
          kind: 'input',
          field: write.name,
          value: write.value,
          basis: null,
          playbookVersion: locked.playbookVersion,
          createdByUserId: args.createdByUserId,
        },
        { transaction }
      );
    }

    if (revision !== locked.revision) {
      locked.revision = revision;
      await locked.save({ transaction });
    }
  });

  await advancePlaybookCase({ caseDbId: found.id as number });
  return mapPlaybookCase(await playbookCases.reload(found));
};
