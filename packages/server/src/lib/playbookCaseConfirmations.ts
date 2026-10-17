import createDebug from 'debug';

import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import { advancePlaybookCase } from './playbookCascade';
import {
  appendEntries,
  caseDefinition,
  caseNodeStates,
  playbookCases,
  withLockedCase,
} from './playbookCases';
import { answerPlaybookCase } from './playbookCaseWait';
import type { PlaybookNode } from './playbookDefinition';
import { readCaseNode } from './playbookExecutions';
import { assertNotOwnWork } from './playbookSelfWrite';
import type { PlaybookNodeView } from './playbookState';

const log = createDebug('soat:playbookCases');

type Confirmation =
  | { decision: 'approve'; expectedRevisions: Record<string, unknown> }
  | {
      decision: 'reject';
      reason: string;
      expectedRevisions: Record<string, unknown>;
    };

/** Reads a confirmation from the wire. */
export const parseConfirmation = (
  body: Record<string, unknown>
): Confirmation => {
  const expectedRevisions = body.expected_revisions;
  if (!isPlainObject(expectedRevisions)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "expected_revisions must map each of the node's inputs to the revision read, or null for an unset one."
    );
  }
  if (body.decision === 'approve') {
    return { decision: 'approve', expectedRevisions };
  }
  if (
    body.decision === 'reject' &&
    typeof body.reason === 'string' &&
    body.reason.trim() !== ''
  ) {
    return { decision: 'reject', reason: body.reason, expectedRevisions };
  }
  throw new DomainError(
    'VALIDATION_FAILED',
    'decision must be approve, or reject with a non-empty reason.'
  );
};

const assertConfirmable = (args: {
  node: PlaybookNode;
  view: PlaybookNodeView;
}): void => {
  const { node, view } = args;
  const blocked = view.missing.length > 0 || view.blockedBy.length > 0;
  if (node.kind === 'confirm' && !blocked) return;
  throw new DomainError(
    'PLAYBOOK_NODE_NOT_CONFIRMABLE',
    `Node '${node.key}' cannot be confirmed now.`,
    {
      node: node.key,
      state: view.state,
      missing: view.missing,
      blocked_by: view.blockedBy,
    }
  );
};

/** Every input whose revision is not the one the confirmer read. */
const conflictsOf = (args: {
  node: PlaybookNode;
  view: PlaybookNodeView;
  expectedRevisions: Record<string, unknown>;
}) => {
  return args.node.inputs.flatMap((input) => {
    const current = args.view.basis[input.name]?.revision ?? null;
    const expected = args.expectedRevisions[input.name];
    return expected === current
      ? []
      : [
          {
            node: args.node.key,
            input: input.name,
            expected_revision: expected ?? null,
            current_revision: current,
          },
        ];
  });
};

/**
 * Approves or rejects a `confirm` node on the inputs the confirmer read. An
 * approval makes the inputs the node's output; a rejection holds the node
 * `rejected`, and everything reading it, until its inputs change or it is
 * approved. Either is refused when an input moved since it was read.
 */
export const confirmPlaybookCaseNode = async (args: {
  projectIds?: number[];
  id: string;
  node: string;
  confirmation: Confirmation;
  createdByUserId: number | null;
  runWorkPublicId?: string;
  wait?: boolean;
}) => {
  log('confirmPlaybookCaseNode: id=%s node=%s', args.id, args.node);
  const row = await playbookCases.getByPublicId(args);
  await assertNotOwnWork({
    caseDbId: row.id as number,
    casePublicId: row.publicId,
    runWorkPublicId: args.runWorkPublicId,
  });
  const definition = await caseDefinition({ row });
  const node = readCaseNode({ definition, node: args.node });
  const { confirmation } = args;

  await withLockedCase({
    row,
    work: async ({ locked, transaction }) => {
      const { views } = await caseNodeStates({
        caseDbId: locked.id as number,
        definition,
        transaction,
      });
      const view = views.get(node.key)!;
      assertConfirmable({ node, view });

      const conflicts = conflictsOf({
        node,
        view,
        expectedRevisions: confirmation.expectedRevisions,
      });
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
        entries: [
          {
            node: node.key,
            kind:
              confirmation.decision === 'approve'
                ? 'confirmation'
                : 'rejection',
            field: null,
            value:
              confirmation.decision === 'approve'
                ? view.values
                : { reason: confirmation.reason },
            basis: view.basis,
            playbookVersion: row.playbookVersion,
            createdByUserId: args.createdByUserId,
          },
        ],
      });
    },
  });

  await advancePlaybookCase({ caseDbId: row.id as number });
  return answerPlaybookCase({ row, wait: args.wait === true });
};
