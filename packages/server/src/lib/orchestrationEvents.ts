import createDebug from 'debug';

import { emitEvent, resolveProjectPublicId } from './eventBus';
import type { MappedOrchestrationRun } from './orchestrations';

const log = createDebug('soat:orchestrations');

/**
 * Run lifecycle event types emitted through the webhooks module so callers can
 * observe a durable background run without polling the API. Named
 * `orchestration_runs.<verb>` to match the `<resource>.<verb>` convention used
 * by the other emitters (e.g. `sessions.created`).
 */
export const RUN_EVENT_TYPES = {
  started: 'orchestration_runs.started',
  awaitingInput: 'orchestration_runs.awaiting_input',
  succeeded: 'orchestration_runs.succeeded',
  failed: 'orchestration_runs.failed',
} as const;

export type RunLifecycleEvent = keyof typeof RUN_EVENT_TYPES;

/**
 * Maps a run status to the lifecycle event that should fire when a run settles
 * into it. `sleeping` (parked on a timer) and `queued` are not terminal for
 * eventing, so they have no event here; `run.started` is emitted explicitly at
 * creation.
 */
export const lifecycleEventForStatus = (
  status: MappedOrchestrationRun['status']
): RunLifecycleEvent | null => {
  switch (status) {
    case 'awaiting_input':
      return 'awaitingInput';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
};

/**
 * Fire-and-forget emit of a run lifecycle event. The project public ID is
 * resolved asynchronously (mirroring the other emitters) so callers never block
 * on eventing; failures are swallowed since webhook delivery is best-effort.
 */
export const emitRunLifecycleEvent = (args: {
  event: RunLifecycleEvent;
  projectId: number;
  run: MappedOrchestrationRun;
}): void => {
  const { event, projectId, run } = args;
  log('emitRunLifecycleEvent event=%s runId=%s', event, run.id);
  resolveProjectPublicId({ projectId })
    .then((projectPublicId) => {
      emitEvent({
        type: RUN_EVENT_TYPES[event],
        projectId,
        projectPublicId,
        resourceType: 'orchestration_run',
        resourceId: run.id,
        data: { ...run },
        timestamp: new Date().toISOString(),
      });
    })
    .catch(() => {
      /* best-effort */
    });
};
