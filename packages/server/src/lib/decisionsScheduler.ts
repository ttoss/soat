import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { announceDecision, interruptDecision } from './decisions';
import { createScheduler, createSweep } from './scheduler';

const log = createDebug('soat:decisions');

type DecisionInstance = InstanceType<(typeof db)['Decision']>;

/**
 * Settles, as interrupted, every decision still unsettled past its lease — the
 * ones a process stopped evaluating. A live evaluation that outruns its lease
 * loses the same way: its late answer finds the decision settled and is
 * discarded. Returns the number settled this tick.
 */
export const sweepInterruptedDecisions = createSweep<DecisionInstance>({
  log,
  name: 'sweepInterruptedDecisions',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.Decision.findAll({
      where: {
        status: ['queued', 'running'],
        leaseExpiresAt: { [Op.lt]: now },
      },
      order: [['leaseExpiresAt', 'ASC']],
      limit,
    });
  },
  idOf: (row) => {
    return row.id as number;
  },
  claim: ({ row, now }) => {
    return interruptDecision({ decisionDbId: row.id as number, now });
  },
  handle: ({ row }) => {
    return announceDecision({ decisionDbId: row.id as number });
  },
});

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 60_000,
  envVar: 'DECISIONS_SCHEDULER_INTERVAL_MS',
  sweeps: [sweepInterruptedDecisions],
});

/** Starts the interrupted-decision sweep. Called once from `server.ts`. */
export const startDecisionsScheduler = scheduler.start;

/** Stops the sweep (graceful shutdown / test teardown). */
export const stopDecisionsScheduler = scheduler.stop;
