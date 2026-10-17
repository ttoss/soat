import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';

/**
 * Refuses a write into a case from the work it is running: a run-as token
 * minted for the case, for one of its executions in flight, or for the task or
 * run one started. An executor feeding its own case would re-trigger itself.
 */
export const assertNotOwnWork = async (args: {
  caseDbId: number;
  casePublicId: string;
  runWorkPublicId?: string;
}): Promise<void> => {
  const work = args.runWorkPublicId;
  if (!work) return;
  const own =
    work === args.casePublicId ||
    (await db.PlaybookExecution.count({
      where: {
        caseId: args.caseDbId,
        status: ['queued', 'running'],
        [Op.or]: [{ publicId: work }, { runId: work }],
      },
    })) > 0;
  if (own) {
    throw new DomainError(
      'PLAYBOOK_SELF_WRITE',
      `Case '${args.casePublicId}' cannot be written by work it is running.`,
      { work }
    );
  }
};
