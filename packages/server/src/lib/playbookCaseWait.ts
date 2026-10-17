import createDebug from 'debug';

import { caseAutomation } from './playbookCaseAutomation';
import {
  caseDefinition,
  caseNodeStates,
  mapPlaybookCase,
  type PlaybookCaseRow,
  playbookCases,
} from './playbookCases';
import { EXECUTION_LEASE_MS } from './playbookExecutionLease';

const log = createDebug('soat:playbookCases');

const POLL_MIN_MS = 50;
const POLL_MAX_MS = 1000;

/**
 * At rest when nothing of the case's own is in flight and nothing is left to
 * queue: a settle commits before it queues the next wave, so an `idle` case can
 * still hold a runnable node for an instant.
 */
const atRest = async (row: PlaybookCaseRow): Promise<boolean> => {
  const { automation_status: status } = (await caseAutomation({ rows: [row] }))(
    row
  );
  if (status === 'paused') return true;
  if (status === 'running') return false;
  const { views } = await caseNodeStates({
    caseDbId: row.id as number,
    definition: await caseDefinition({ row }),
  });
  return ![...views.values()].some((view) => {
    return view.runnable;
  });
};

/**
 * The case as a write leaves it. With `wait`, once every execution the write
 * queued, and every one those queue in turn, has settled or parked on a task
 * or run, or the case is paused; bounded by the execution lease, past which a
 * running execution is recovered as interrupted.
 */
export const answerPlaybookCase = async (args: {
  row: PlaybookCaseRow;
  wait: boolean;
}) => {
  if (args.wait) {
    const deadline = Date.now() + EXECUTION_LEASE_MS;
    let delay = POLL_MIN_MS;
    while (!(await atRest(await playbookCases.reload(args.row)))) {
      if (Date.now() >= deadline) {
        log('answerPlaybookCase: %s still running', args.row.publicId);
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
  }
  return mapPlaybookCase(await playbookCases.reload(args.row));
};
