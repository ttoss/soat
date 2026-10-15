import createDebug from 'debug';

import { DomainError } from '../errors';
import { advancePlaybookCase, kickPlaybookWorker } from './playbookCascade';
import { mapPlaybookCase, playbookCases } from './playbookCases';

const log = createDebug('soat:playbookCases');

/**
 * Stops the case starting anything: the cascade queues nothing and the worker
 * claims none of its pending executions. Executions already running settle.
 * Pausing a paused case keeps the first pause.
 */
export const pausePlaybookCase = async (args: {
  projectIds?: number[];
  id: string;
}) => {
  log('pausePlaybookCase: id=%s', args.id);
  const row = await playbookCases.getByPublicId(args);
  if (!row.pauseRequestedAt) await row.update({ pauseRequestedAt: new Date() });
  return mapPlaybookCase(await playbookCases.reload(row));
};

/** Lifts the pause, queues what became runnable meanwhile, and wakes the worker. */
export const resumePlaybookCase = async (args: {
  projectIds?: number[];
  id: string;
}) => {
  log('resumePlaybookCase: id=%s', args.id);
  const row = await playbookCases.getByPublicId(args);
  if (!row.pauseRequestedAt) {
    throw new DomainError(
      'PLAYBOOK_CASE_NOT_PAUSED',
      `Case '${args.id}' is not paused.`
    );
  }
  await row.update({ pauseRequestedAt: null });
  await advancePlaybookCase({ caseDbId: row.id as number });
  // Executions queued before the pause are pending still.
  kickPlaybookWorker();
  return mapPlaybookCase(await playbookCases.reload(row));
};
