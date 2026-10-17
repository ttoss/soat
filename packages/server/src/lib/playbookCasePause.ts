import createDebug from 'debug';

import { DomainError } from '../errors';
import { advancePlaybookCase, kickPlaybookWorker } from './playbookCascade';
import { mapPlaybookCase, playbookCases } from './playbookCases';
import { assertProjectAcceptsWork } from './projectPause';

const log = createDebug('soat:playbookCases');

/**
 * Stops the case starting anything: the cascade queues nothing and the worker
 * claims none of its queued executions. Executions already running settle.
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
  // Lifting one case's pause under a paused project would restart the work the
  // project's pause holds; the project's resume hands its cases back.
  await assertProjectAcceptsWork({ projectId: row.projectId });
  await row.update({ pauseRequestedAt: null });
  await advancePlaybookCase({ caseDbId: row.id as number });
  // Executions queued before the pause stay queued.
  kickPlaybookWorker();
  return mapPlaybookCase(await playbookCases.reload(row));
};
