/**
 * Fails generations whose running process stopped renewing their lease: it
 * died, or lost its database. The settle releases the session and announces
 * `generations.failed`, so a parent waiting on a handoff is told. A run still
 * alive somewhere loses its next renewal and cancels itself.
 */
import createDebug from 'debug';

import { DomainError } from '../errors';
import { findExpiredGenerations, settleGeneration } from './generationSettle';
import { createScheduler } from './scheduler';
import { toStoredErrorKeepingMessage } from './storedError';
import { recordTraceError } from './traceWrite';

const log = createDebug('soat:generation-sweep');

const BATCH_LIMIT = 50;
const DEFAULT_INTERVAL_MS = 60 * 1000;

const interrupted = (generationId: string): DomainError => {
  return new DomainError(
    'GENERATION_INTERRUPTED',
    'The process running the generation stopped renewing its lease.',
    { generation_id: generationId }
  );
};

/** Fails every generation whose lease lapsed by `now`; the count it settled. */
export const sweepExpiredGenerations = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();
  const due = await findExpiredGenerations({ now, limit: BATCH_LIMIT });
  let swept = 0;
  for (const gen of due) {
    const error = toStoredErrorKeepingMessage({
      error: interrupted(gen.generationId),
      code: 'GENERATION_INTERRUPTED',
    });
    const settled = await settleGeneration({
      generationId: gen.generationId,
      fence: 'expired',
      now,
      outcome: { status: 'failed', error },
      effects: () => {
        return [recordTraceError({ traceId: gen.tracePublicId, error })];
      },
    });
    if (settled) swept += 1;
  }
  log('sweepExpiredGenerations: due=%d swept=%d', due.length, swept);
  return swept;
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: DEFAULT_INTERVAL_MS,
  envVar: 'GENERATION_SWEEP_INTERVAL_MS',
  disabledEnvVar: 'GENERATION_SWEEP_DISABLED',
  sweeps: [sweepExpiredGenerations],
});

export const startGenerationSweepScheduler = scheduler.start;
