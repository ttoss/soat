import createDebug from 'debug';

import { db } from '../db';
import {
  assertExecutorStartable,
  type PlaybookRunAs,
  resolvePlaybookRunAs,
} from './playbookAuthor';
import {
  caseDefinition,
  caseSnapshot,
  type PlaybookCaseRow,
  playbookCases,
} from './playbookCases';
import { conformsToInputSchema } from './playbookCaseState';
import type { PlaybookNode } from './playbookDefinition';
import { settleExecution, settleFromOutcome } from './playbookExecutionSettle';
import { startExecutor } from './playbookExecutors';
import { nodesByKey } from './playbookGraph';
import { playbookNodeStates, samePlaybookBasis } from './playbookState';

const log = createDebug('soat:playbookExecutions');

/** The case's author, checked against this node's executor before it runs. */
export const resolveRunAs = async (args: {
  row: PlaybookCaseRow;
  node: PlaybookNode & { executor: NonNullable<PlaybookNode['executor']> };
}): Promise<PlaybookRunAs> => {
  const { row, node } = args;
  const version = await db.PlaybookVersion.findOne({
    where: { playbookId: row.playbookId, version: row.playbookVersion },
    attributes: ['principalKind', 'principalId'],
  });
  const runAs = await resolvePlaybookRunAs({
    version: version!,
    projectId: row.projectId,
    workPublicId: row.publicId,
  });
  await assertExecutorStartable({
    node: node.key,
    executor: node.executor,
    projectPublicId: row.project.publicId,
    isAllowed: runAs.isAllowed,
  });
  return runAs;
};

/**
 * Runs an execution this process has claimed. Its node is read again first:
 * one whose inputs moved since it was queued settles `superseded` without
 * running, and otherwise the values it runs on are the ones it was queued
 * with.
 */
export const executeClaimed = async (args: {
  executionId: number;
}): Promise<void> => {
  const execution = await db.PlaybookExecution.findByPk(args.executionId);
  if (!execution) return;
  const row = await playbookCases.reload(
    (await db.PlaybookCase.findByPk(execution.caseId))!
  );
  const definition = await caseDefinition({ row });
  const node = nodesByKey({ definition }).get(execution.node)!;
  const view = playbookNodeStates({
    definition,
    snapshot: await caseSnapshot({ caseDbId: row.id as number }),
    conforms: conformsToInputSchema,
  }).get(node.key)!;

  if (
    !samePlaybookBasis({
      left: view.basis,
      right: execution.basis as typeof view.basis,
    })
  ) {
    log('executeClaimed: %s superseded before it ran', execution.publicId);
    await settleExecution({
      executionId: execution.id as number,
      settlement: { output: null, runId: null },
    });
    return;
  }

  const { executor } = node;
  await settleFromOutcome({
    execution,
    outcome: async () => {
      if (!executor) {
        return { kind: 'settled', output: view.values, runId: null };
      }
      return startExecutor({
        executor,
        values: view.values,
        input: execution.input as Record<string, unknown>,
        projectId: row.projectId,
        executionPublicId: execution.publicId,
        title: `${row.subject} · ${node.title}`,
        runAs: await resolveRunAs({ row, node: { ...node, executor } }),
      });
    },
  });
};
