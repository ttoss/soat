import createDebug from 'debug';

import { loggableError } from './loggableError';
import type { ActiveDispatch } from './tasks';

const log = createDebug('soat:tasks');

/** Best-effort cancellation of a still-running dispatch when a task leaves its state. */
export const cancelDispatchOnExit = async (args: {
  previous: ActiveDispatch | null;
  projectId: number;
}): Promise<void> => {
  const prev = args.previous;
  if (!prev || prev.status !== 'running') return;
  if (prev.kind === 'orchestration_run' && prev.id) {
    try {
      const { cancelOrchestrationRun } =
        await import('./orchestrationRunActions');
      await cancelOrchestrationRun({
        runPublicId: prev.id,
        projectIds: [args.projectId],
      });
    } catch (error) {
      // A terminal run is not cancellable — nothing to do.
      log('cancelDispatchOnExit: %o', loggableError(error));
    }
  }
  // Generation dispatches are detached: their late result is discarded by the
  // staleness check in tasksAutomation (task re-validated on completion).
};
