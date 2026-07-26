import createDebug from 'debug';

import { DomainError } from '../../errors';
import { postgresQueueDriver } from './postgresQueueDriver';
import { createSqsQueueDriver } from './sqsQueueDriver';
import type { OrchestrationQueueDriver, QueueDriverName } from './types';

const log = createDebug('soat:orchestrations');

export type {
  ClaimedTask,
  OrchestrationQueueDriver,
  QueueDriverName,
  QueueStats,
  RunTaskKind,
} from './types';

const DRIVER_NAMES: readonly QueueDriverName[] = ['postgres', 'sqs'];

/**
 * The configured driver name. Postgres is the default so a deployment that
 * never sets the variable keeps today's behaviour; an unrecognized value is a
 * hard error rather than a silent fallback — running the wrong queue is worse
 * than refusing to start.
 */
export const queueDriverName = (): QueueDriverName => {
  const configured = process.env.ORCHESTRATION_QUEUE_DRIVER;
  if (!configured) return 'postgres';
  if (!DRIVER_NAMES.includes(configured as QueueDriverName)) {
    throw new DomainError(
      'QUEUE_DRIVER_MISCONFIGURED',
      `Unknown ORCHESTRATION_QUEUE_DRIVER '${configured}'. Expected one of: ${DRIVER_NAMES.join(', ')}.`
    );
  }
  return configured as QueueDriverName;
};

let cached: OrchestrationQueueDriver | undefined;

/**
 * The active queue driver, built once per process from
 * `ORCHESTRATION_QUEUE_DRIVER` and cached. Every caller in the runtime — the
 * engine's enqueue, the scheduler's sweeps, the worker's claim/ack, and the
 * stats endpoint — goes through this, so swapping the backend is an env change
 * and nothing else.
 */
export const getOrchestrationQueueDriver = (): OrchestrationQueueDriver => {
  if (cached) return cached;
  const name = queueDriverName();
  cached = name === 'sqs' ? createSqsQueueDriver() : postgresQueueDriver;
  log('getOrchestrationQueueDriver: driver=%s', name);
  return cached;
};

/**
 * Drops the cached driver so the next call rebuilds it from the environment.
 * Used by tests that switch drivers, and safe to call at any time (in-flight
 * work holds its own reference).
 */
export const resetOrchestrationQueueDriver = (): void => {
  cached = undefined;
};
