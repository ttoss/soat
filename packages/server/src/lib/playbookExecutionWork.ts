import createDebug from 'debug';

import { db } from '../db';
import {
  assertExecutorStartable,
  type PlaybookRunAs,
  resolvePlaybookRunAs,
} from './playbookAuthor';
import {
  caseDefinition,
  caseNodeStates,
  type PlaybookCaseRow,
  playbookCases,
} from './playbookCases';
import type { PlaybookExecutor } from './playbookDefinition';
import { settleExecution, settleFromOutcome } from './playbookExecutionSettle';
import { startExecutor } from './playbookExecutors';
import { nodesByKey } from './playbookGraph';
import { samePlaybookBasis } from './playbookState';

const log = createDebug('soat:playbookExecutions');

/** The case's author, checked against what a node starts before it runs. */
export const resolveRunAs = async (args: {
  row: PlaybookCaseRow;
  node: string;
  executors: PlaybookExecutor[];
}): Promise<PlaybookRunAs> => {
  const { row } = args;
  const version = await db.PlaybookVersion.findOne({
    where: { playbookId: row.playbookId, version: row.playbookVersion },
    attributes: ['principalKind', 'principalId'],
  });
  const runAs = await resolvePlaybookRunAs({
    version: version!,
    projectId: row.projectId,
    workPublicId: row.publicId,
  });
  for (const executor of args.executors) {
    await assertExecutorStartable({
      node: args.node,
      executor,
      projectPublicId: row.project.publicId,
      isAllowed: runAs.isAllowed,
    });
  }
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
  const { views } = await caseNodeStates({
    caseDbId: row.id as number,
    definition,
  });
  const view = views.get(node.key)!;

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
        runAs: await resolveRunAs({
          row,
          node: node.key,
          executors: [executor],
        }),
      });
    },
  });
};
