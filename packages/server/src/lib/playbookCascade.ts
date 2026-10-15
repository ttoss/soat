import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { caseDefinition, caseSnapshot, playbookCases } from './playbookCases';
import { conformsToInputSchema } from './playbookCaseState';
import {
  EXECUTION_LEASE_MS,
  PARKED_RECHECK_MS,
} from './playbookExecutionLease';
import { settleExecution, settleFromRun } from './playbookExecutionSettle';
import { executeClaimed } from './playbookExecutionWork';
import { executorInput } from './playbookExecutors';
import { recoverPlaybookExports } from './playbookExportRender';
import { playbookNodeStates } from './playbookState';
import { createScheduler, createSweep } from './scheduler';

const log = createDebug('soat:playbookCascade');

type ExecutionRow = InstanceType<(typeof db)['PlaybookExecution']>;

/** Claims a pending execution: a conditional update, so one worker wins. */
const claimPending = async (args: {
  execution: ExecutionRow;
  now: Date;
}): Promise<boolean> => {
  const [claimed] = await db.PlaybookExecution.update(
    {
      status: 'running',
      leaseExpiresAt: new Date(args.now.getTime() + EXECUTION_LEASE_MS),
    },
    { where: { id: args.execution.id as number, status: 'pending' } }
  );
  return claimed === 1;
};

/** Pending executions whose case and project accept work. */
const findPending = (args: { limit: number }) => {
  return db.PlaybookExecution.findAll({
    where: { status: 'pending' },
    include: [
      {
        model: db.PlaybookCase,
        as: 'case',
        required: true,
        attributes: [],
        where: { pauseRequestedAt: null },
        include: [
          {
            model: db.Project,
            as: 'project',
            required: true,
            attributes: [],
            where: { pausedAt: null },
          },
        ],
      },
    ],
    order: [['id', 'ASC']],
    limit: args.limit,
  });
};

/** Runs one batch of pending executions to completion. */
const drainPendingOnce = async (): Promise<number> => {
  const now = new Date();
  const claimed: ExecutionRow[] = [];
  for (const execution of await findPending({ limit: 20 })) {
    if (await claimPending({ execution, now })) claimed.push(execution);
  }
  const results = await Promise.allSettled(
    claimed.map((execution) => {
      return executeClaimed({ executionId: execution.id as number });
    })
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      log(
        'drainPendingOnce: %s failed %o',
        claimed[index].publicId,
        result.reason
      );
    }
  }
  return claimed.length;
};

let draining: Promise<void> | null = null;
let again = false;

const drainLoop = async (): Promise<void> => {
  do {
    again = false;
    let claimed = await drainPendingOnce();
    while (claimed > 0) claimed = await drainPendingOnce();
  } while (again);
};

/**
 * Starts draining pending executions in this process, or asks the drain
 * already running for one more pass. A settle inside the drain queues the
 * next wave, so one kick carries a cascade to rest.
 */
export const kickPlaybookWorker = (): void => {
  if (process.env.PLAYBOOK_WORKER_DISABLED === 'true') return;
  if (draining) {
    again = true;
    return;
  }
  draining = drainLoop().finally(() => {
    draining = null;
  });
};

/** Awaits the drain until nothing is left to claim; for tests and shutdown. */
export const flushPlaybookExecutions = async (): Promise<void> => {
  while (draining) await draining;
};

/**
 * Queues an execution for every node of the case that can run now, under the
 * case's lock, so two writers never queue one node twice. A paused case queues
 * nothing. Called after every write that can make a node runnable: a case
 * created, inputs written, an execution settled, a pause lifted.
 */
export const advancePlaybookCase = async (args: {
  caseDbId: number;
}): Promise<void> => {
  const queued = await db.sequelize.transaction(async (transaction) => {
    const locked = await db.PlaybookCase.findByPk(args.caseDbId, {
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!locked || locked.pauseRequestedAt) return 0;

    const row = await playbookCases.reload(locked);
    const definition = await caseDefinition({ row });
    const views = playbookNodeStates({
      definition,
      snapshot: await caseSnapshot({ caseDbId: args.caseDbId, transaction }),
      conforms: conformsToInputSchema,
    });

    let count = 0;
    for (const node of definition.nodes) {
      const view = views.get(node.key)!;
      if (!view.runnable) continue;
      await db.PlaybookExecution.create(
        {
          caseId: args.caseDbId,
          node: node.key,
          playbookVersion: row.playbookVersion,
          executorType: node.executor?.type ?? null,
          executorId: node.executor?.id ?? null,
          status: 'pending',
          basis: view.basis,
          input: executorInput({
            executor: node.executor,
            values: view.values,
          }),
          createdByUserId: null,
        },
        { transaction }
      );
      count += 1;
    }
    return count;
  });

  log('advancePlaybookCase: case=%d queued=%d', args.caseDbId, queued);
  if (queued > 0) kickPlaybookWorker();
};

/**
 * Recovers a `running` execution past its lease. One with no run of its own
 * was running in a process that stopped, and fails as interrupted rather than
 * running twice; one waiting on a task or run reads it again, which settles it
 * when the event that would have was never delivered.
 */
export const recoverPlaybookExecutions = createSweep<ExecutionRow>({
  log,
  name: 'recoverPlaybookExecutions',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.PlaybookExecution.findAll({
      where: { status: 'running', leaseExpiresAt: { [Op.lt]: now } },
      order: [['leaseExpiresAt', 'ASC']],
      limit,
    });
  },
  idOf: (row) => {
    return row.id as number;
  },
  claim: async ({ row, now }) => {
    const [claimed] = await db.PlaybookExecution.update(
      { leaseExpiresAt: new Date(now.getTime() + PARKED_RECHECK_MS) },
      {
        where: {
          id: row.id as number,
          status: 'running',
          leaseExpiresAt: row.leaseExpiresAt,
        },
      }
    );
    return claimed === 1;
  },
  handle: async ({ row }) => {
    if (row.runId) {
      await settleFromRun({ execution: row });
      return;
    }
    log('recoverPlaybookExecutions: %s interrupted', row.publicId);
    await settleExecution({
      executionId: row.id as number,
      settlement: {
        error: {
          code: 'PLAYBOOK_EXECUTION_INTERRUPTED',
          message:
            'The process running this execution stopped before it settled.',
        },
      },
    });
  },
});

/** Picks up what no kick reached: work queued by another process, or before a restart. */
export const drainPlaybookExecutions = async (): Promise<number> => {
  kickPlaybookWorker();
  await flushPlaybookExecutions();
  return 0;
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 30_000,
  envVar: 'PLAYBOOK_SCHEDULER_INTERVAL_MS',
  disabledEnvVar: 'PLAYBOOK_WORKER_DISABLED',
  sweeps: [
    drainPlaybookExecutions,
    recoverPlaybookExecutions,
    recoverPlaybookExports,
  ],
});

/** Starts the cascade's sweeps. Called once from `server.ts`. */
export const startPlaybookScheduler = scheduler.start;

/** Stops the sweeps (graceful shutdown / test teardown). */
export const stopPlaybookScheduler = scheduler.stop;
