/**
 * The eval worker (the evaluations module doc).
 *
 * Two sweeps on one timer, mirroring `orchestrationWorker.ts`:
 *
 * 1. **Drain** — claim a batch of due item tasks, execute each item, ack it, and
 *    settle the run once its last task is gone.
 * 2. **Reap** — recover runs that were left mid-flight, which is the debt Phase 1
 *    knowingly took on (a client that disconnected during a `wait: true` run left
 *    its row `running` forever, with nothing to clean it).
 *
 * Runs inside the API process by default, so a single-process deployment needs no
 * separate worker; `EVAL_WORKER_DISABLED=true` keeps the API tier request-only
 * for deployments running a dedicated fleet.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import {
  ackEvalItemTask,
  claimEvalItemTasks,
  countPendingEvalItemTasks,
  type EvalRunTaskInstance,
} from './evaluationQueue';
import {
  claimRunFinalization,
  executeAndRecordItem,
  failEvalRun,
  finalizeIfUnclaimed,
  recountEvalRunProgress,
} from './evaluationRunExecution';
import { scorerList } from './evaluationScorers';
import { createScheduler } from './scheduler';

const log = createDebug('soat:evaluations');

const DEFAULT_WORKER_BATCH = 5;
const DEFAULT_ABANDONED_AFTER_MS = 1_800_000;

/**
 * Items claimed per tick. Lower than the orchestration worker's 10 because every
 * item here is a real agent generation: the batch size is a bound on concurrent
 * provider calls (and therefore on spend rate), not just on rows.
 */
const workerBatchLimit = (): number => {
  const configured = Number(process.env.EVAL_WORKER_BATCH);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKER_BATCH;
};

/**
 * How long a non-terminal run with **no outstanding work** is left alone before
 * the reaper settles it. Generous by default (30 min) because the case it must
 * not misfire on is a legitimately slow synchronous run: those hold no task rows,
 * so from the reaper's side they look exactly like an abandoned one until they
 * finish.
 */
const abandonedAfterMs = (): number => {
  const configured = Number(process.env.EVAL_RUN_ABANDONED_AFTER_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_ABANDONED_AFTER_MS;
};

/** A run that still has work ahead of it, as opposed to one already settled. */
const isLive = (status: string): boolean => {
  return status === 'queued' || status === 'running';
};

type LoadedRun = {
  run: InstanceType<(typeof db)['EvalRun']>;
  evalPublicId: string;
  projectId: number;
  passThreshold: number | null;
};

/** Loads a run together with the Eval fields execution and finalize need. */
const loadRunContext = async (args: {
  evalRunId: number;
}): Promise<LoadedRun | null> => {
  const run = await db.EvalRun.findByPk(args.evalRunId);
  /* istanbul ignore next -- a task's FK to its run is NOT NULL with CASCADE
     delete, so a claimable task always has a live run; and the Eval FK on the
     run is NOT NULL with CASCADE too. Neither is reachable through any entry
     point — the guards exist so a future caller cannot crash the drain loop. */
  if (!run) return null;

  const evaluation = await db.Eval.findByPk(run.evalId as number);
  /* istanbul ignore next -- see above. */
  if (!evaluation) return null;

  return {
    run,
    evalPublicId: evaluation.publicId,
    projectId: evaluation.projectId as number,
    passThreshold:
      evaluation.passThreshold === null
        ? null
        : Number(evaluation.passThreshold),
  };
};

/**
 * Settles a run whose queue has drained.
 *
 * The finalize claim is what makes this safe to call from every worker that acks
 * a last-looking task: only one wins.
 */
const settleIfDrained = async (args: { evalRunId: number }): Promise<void> => {
  const pending = await countPendingEvalItemTasks({
    evalRunId: args.evalRunId,
  });
  if (pending > 0) return;

  const context = await loadRunContext({ evalRunId: args.evalRunId });
  /* istanbul ignore next -- see `loadRunContext`. */
  if (!context) return;

  // A run that is no longer live has nothing left to settle: it was cancelled
  // (which dropped its tasks and deliberately published no partial aggregate),
  // or a redelivered task arrived after it had already completed.
  if (!isLive(context.run.status)) return;

  await finalizeIfUnclaimed(context);
};

/** The agent, item and scorer config one task needs to execute. */
const loadItemTarget = async (args: {
  evalDbId: number;
  datasetItemDbId: number;
}): Promise<{
  agent: InstanceType<(typeof db)['Agent']>;
  item: InstanceType<(typeof db)['DatasetItem']>;
  scorers: unknown[];
} | null> => {
  const evaluation = (await db.Eval.findByPk(args.evalDbId, {
    include: [{ model: db.Agent, as: 'agent' }],
  })) as
    | (InstanceType<(typeof db)['Eval']> & {
        agent?: InstanceType<(typeof db)['Agent']>;
      })
    | null;
  const item = await db.DatasetItem.findByPk(args.datasetItemDbId);

  /* istanbul ignore next -- the agent FK is NOT NULL, and deleting a dataset
     item cascades its task away before it can be claimed. */
  if (!evaluation?.agent || !item) return null;

  return {
    agent: evaluation.agent,
    item,
    scorers: scorerList(evaluation.scorers),
  };
};

/**
 * Executes one claimed item task.
 *
 * A run that is no longer live (canceled between the claim and here) drops the
 * task without spending a generation on it. Everything else runs the item; a
 * per-item failure is already recorded *as* the item's result by
 * `executeAndRecordItem`, so this only rethrows on an unexpected infrastructure
 * error, which leaves the task un-acked for lease-based redelivery.
 */
const handleEvalItemTask = async (args: {
  task: EvalRunTaskInstance;
}): Promise<void> => {
  const context = await loadRunContext({
    evalRunId: args.task.evalRunId as number,
  });
  /* istanbul ignore next -- see `loadRunContext`. */
  if (!context) return;

  const { run } = context;
  if (!isLive(run.status)) {
    log(
      'handleEvalItemTask: run=%s is %s, dropping task %s',
      run.publicId,
      run.status,
      args.task.publicId
    );
    return;
  }

  // First item of a queued run: the run is now genuinely under way.
  if (run.status === 'queued') {
    await run.update({
      status: 'running',
      startedAt: run.startedAt ?? new Date(),
    });
  }

  const target = await loadItemTarget({
    evalDbId: run.evalId as number,
    datasetItemDbId: args.task.datasetItemId as number,
  });
  /* istanbul ignore next -- the agent FK is NOT NULL, and a deleted item
     cascades its task away before it can be claimed. */
  if (!target) return;
  const { agent, item, scorers } = target;

  log(
    'handleEvalItemTask: run=%s item=%s attempt=%d',
    run.publicId,
    item.publicId,
    args.task.attempts
  );

  await executeAndRecordItem({
    projectId: context.projectId,
    runDbId: run.id as number,
    agent,
    agentVersion: run.agentVersion as number,
    scorers,
    item,
  });

  // The run may have been canceled while this item was in flight: the claim
  // happened before the cancel, so the liveness check above let it through and
  // the result landed after the run had already settled. Reconcile the counters
  // with what actually ran — a canceled run publishes no `aggregate_scores`, so
  // these counts are its only record of the work that was really paid for.
  await run.reload();
  if (!isLive(run.status)) {
    await recountEvalRunProgress({ run });
  }
};

/**
 * Claims one batch of due item tasks and executes each, acking on completion.
 * A task whose handler throws is left un-acked (its lease expires → redelivery)
 * while the rest still ack. Returns the number of tasks claimed.
 */
export const drainEvalQueueOnce = async (args?: {
  limit?: number;
  now?: Date;
}): Promise<number> => {
  const limit = args?.limit ?? workerBatchLimit();

  let tasks: EvalRunTaskInstance[];
  try {
    tasks = await claimEvalItemTasks({ limit, now: args?.now });
  } catch (error) {
    log('drainEvalQueueOnce: claim failed %o', error);
    return 0;
  }

  const touchedRunIds = new Set<number>();

  await Promise.all(
    tasks.map(async (task) => {
      try {
        await handleEvalItemTask({ task });
        await ackEvalItemTask({ id: task.id as number });
        touchedRunIds.add(task.evalRunId as number);
      } catch (error) {
        // Un-acked: the lease expires and the item is redelivered. Writing the
        // result is idempotent, so a redelivery cannot double-count it.
        log(
          'drainEvalQueueOnce: handle failed task=%s %o',
          task.publicId,
          error
        );
      }
    })
  );

  for (const evalRunId of touchedRunIds) {
    await settleIfDrained({ evalRunId });
  }

  return tasks.length;
};

/**
 * Recovers non-terminal runs that have no outstanding work and have gone quiet
 * past the grace period.
 *
 * Two shapes land here, and they need opposite treatment:
 *
 * - Every item has a result, but the run never settled — a finalize that crashed
 *   between the last ack and the update. The measurements are all there, so the
 *   run is **finalized** rather than thrown away.
 * - Items are missing — an abandoned `wait: true` run whose client disconnected
 *   (the Phase 1 debt), or work that was dropped. Nothing will ever complete it,
 *   so it is settled `failed` and its lifecycle event fires, because a gate
 *   waiting on a verdict must not wait forever.
 */
export const reapAbandonedEvalRuns = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();
  const cutoff = new Date(now.getTime() - abandonedAfterMs());

  let stale: Array<InstanceType<(typeof db)['EvalRun']>>;
  try {
    stale = await db.EvalRun.findAll({
      where: {
        status: { [Op.in]: ['queued', 'running'] },
        createdAt: { [Op.lt]: cutoff },
      },
      limit: 20,
    });
  } catch (error) {
    log('reapAbandonedEvalRuns: query failed %o', error);
    return 0;
  }

  let reaped = 0;

  for (const run of stale) {
    const pending = await countPendingEvalItemTasks({
      evalRunId: run.id as number,
    });
    // Still has queued work: the drain sweep owns it, not the reaper.
    if (pending > 0) continue;

    const context = await loadRunContext({ evalRunId: run.id as number });
    /* istanbul ignore next -- see `loadRunContext`. */
    if (!context) continue;

    const resultCount = await db.EvalResult.count({
      where: { evalRunId: run.id as number },
    });

    if (resultCount >= (run.itemCount as number)) {
      log('reapAbandonedEvalRuns: finalizing stalled run=%s', run.publicId);
      if (!(await finalizeIfUnclaimed({ ...context, now }))) continue;
    } else {
      if (!(await claimRunFinalization({ runDbId: run.id as number, now }))) {
        continue;
      }
      log(
        'reapAbandonedEvalRuns: failing abandoned run=%s results=%d/%d',
        run.publicId,
        resultCount,
        run.itemCount
      );
      await failEvalRun({
        run: context.run,
        evalPublicId: context.evalPublicId,
        projectId: context.projectId,
        reason: `Abandoned with ${resultCount} of ${String(run.itemCount)} items scored.`,
      });
    }

    reaped += 1;
  }

  return reaped;
};

/**
 * In-process worker kick, fired when a run is enqueued so a single-process
 * deployment starts on it immediately instead of waiting for the next tick.
 * `drainEvalQueueOnce` catches its own errors, so this never rejects.
 */
export const kickEvalWorker = (): void => {
  if (process.env.EVAL_WORKER_DISABLED === 'true') return;
  void drainEvalQueueOnce();
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5000,
  envVar: 'EVAL_WORKER_INTERVAL_MS',
  disabledEnvVar: 'EVAL_WORKER_DISABLED',
  sweeps: [drainEvalQueueOnce, reapAbandonedEvalRuns],
});

/** Starts the background loop that drains the eval queue and reaps stale runs. */
export const startEvalWorker = scheduler.start;

/** Stops the background loop (graceful shutdown / test teardown). */
export const stopEvalWorker = scheduler.stop;
