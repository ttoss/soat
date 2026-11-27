import createDebug from 'debug';

import { db } from '../db';
import { workCaller } from '../middleware/auth';
import {
  caseDefinition,
  caseNodeStates,
  type PlaybookCaseRow,
  playbookCases,
} from './playbookCases';
import { settleExecution, settleFromOutcome } from './playbookExecutionSettle';
import { type ExecutorRunAs, startExecutor } from './playbookExecutors';
import { nodesByKey } from './playbookGraph';
import { samePlaybookBasis } from './playbookState';
import { resourceWorkAuthority } from './resourceWork';
import {
  forWork,
  parseWorkAuthority,
  requireWorkAuthority,
  type WorkAuthority,
} from './workAuthority';

const log = createDebug('soat:playbookExecutions');

/**
 * The authority a case's executions run under: its pinned version's grant,
 * so they act as the version whoever wrote it.
 */
export const caseAuthority = async (args: {
  row: PlaybookCaseRow;
}): Promise<WorkAuthority> => {
  const { row } = args;
  const version = await db.PlaybookVersion.findOne({
    where: { playbookId: row.playbookId, version: row.playbookVersion },
    attributes: ['publicId'],
    rejectOnEmpty: true,
  });
  // Each node's starts are checked at their entry points as it runs.
  return resourceWorkAuthority({
    carrier: 'playbookVersions',
    id: version.publicId as string,
    projectId: row.projectId,
    startedBy: null,
    starts: [],
  });
};

/**
 * Work's authority (the case's when none is given), resolved as a request
 * would be, serving the case's actor or none. Work holding none, or whose
 * authority no longer resolves, is refused.
 */
export const resolveRunAs = async (args: {
  row: PlaybookCaseRow;
  authority?: WorkAuthority | null;
  workPublicId?: string;
}): Promise<ExecutorRunAs> => {
  const { row } = args;
  const work = args.workPublicId ?? row.publicId;
  const authority = requireWorkAuthority({
    authority:
      args.authority === undefined
        ? await caseAuthority({ row })
        : args.authority,
    work,
  });
  await workCaller({ db, authority, work });
  return {
    authority: {
      ...forWork({ authority, work }),
      actor: row.actor?.publicId ?? null,
    },
  };
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
  const view = views.get(node.id)!;

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
      if (node.upstream) {
        // The basis matched, so the pulled node is still `done` on it.
        return { kind: 'settled', output: view.pulled ?? null, runId: null };
      }
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
          authority: parseWorkAuthority(execution.authority),
          workPublicId: execution.publicId,
        }),
      });
    },
  });
};
