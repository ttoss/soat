import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';
import type { OnBehalfOf } from './onBehalfOf';
import { casesWithUpstreams } from './playbookCaseUpstreams';

/** The cases `work` runs for: the case it names, or that of each execution in flight it names. */
const casesOfWork = async (args: { work: string }): Promise<number[]> => {
  const named = await db.PlaybookCase.findOne({
    where: { publicId: args.work },
    attributes: ['id'],
  });
  const executions = await db.PlaybookExecution.findAll({
    where: {
      status: ['queued', 'running'],
      [Op.or]: [{ publicId: args.work }, { runId: args.work }],
    },
    attributes: ['caseId'],
  });
  return [
    ...(named ? [named.id as number] : []),
    ...executions.map((execution) => {
      return execution.caseId;
    }),
  ];
};

/**
 * Refuses a write into a case from the work it is running or from the work of
 * a case downstream of it: a run-as token minted for such a case, for one of
 * its executions in flight, or for the task or run one started; or a tool
 * call such work or such a generation made, written back on a project key
 * with its `On-Behalf-Of`. An executor feeding its own case, or a case its case reads,
 * would re-trigger itself.
 */
export const assertNotOwnWork = async (args: {
  caseDbId: number;
  casePublicId: string;
  runWorkPublicId?: string;
  onBehalfOf: OnBehalfOf | null;
}): Promise<void> => {
  // Exclusive: an assertion is accepted only beside a project key.
  const work =
    args.runWorkPublicId ??
    args.onBehalfOf?.work_id ??
    args.onBehalfOf?.generation_id;
  if (!work) return;
  const reached = await casesWithUpstreams({
    caseDbIds: await casesOfWork({ work }),
  });
  if (reached.has(args.caseDbId)) {
    throw new DomainError(
      'PLAYBOOK_SELF_WRITE',
      `Case '${args.casePublicId}' cannot be written by work it, or a case reading it, is running.`,
      { work }
    );
  }
};
