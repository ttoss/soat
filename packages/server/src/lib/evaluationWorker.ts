/**
 * The eval worker (the evaluations module doc). Two sweeps on one timer,
 * mirroring `orchestrationWorker.ts`: **drain** claims a batch of due item
 * tasks, executes and acks each, and settles the run once its last task is
 * gone; **reap** recovers runs left mid-flight — the debt Phase 1 knowingly
 * took on, where a client disconnecting during a `wait: true` run left its row
 * `running` forever.
 *
 * Runs inside the API process by default, so a single-process deployment needs
 * no separate worker; `EVAL_WORKER_DISABLED=true` keeps the API tier
 * request-only for deployments running a dedicated fleet.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { isAdmissionRefusal } from './admission';
import { openRunProbeGate } from './evaluationProbeRuns';
import {
  ackEvalItemTask,
  claimEvalItemTasks,
  countPendingEvalItemTasks,
  discardEvalItemTasks,
  type EvalRunTaskInstance,
} from './evaluationQueue';
import {
  type EvalRunDefinition,
  readEvalRunDefinition,
} from './evaluationRunDefinition';
import {
  claimRunFinalization,
  executeAndRecordItem,
  failEvalRun,
  finalizeIfUnclaimed,
  isLiveRunStatus,
  recountEvalRunProgress,
} from './evaluationRunExecution';
import { readScorerModels } from './evaluationScorerModels';
import { runAsJob } from './requestCorrelation';
import { agentReferences } from './resourceReferences';
import { createScheduler } from './scheduler';
import {
  INTERNAL_FAILURE,
  type OwnStoredError,
  toStoredError,
} from './storedError';
import { parseWorkAuthority } from './workAuthority';

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

type LoadedRun = {
  run: InstanceType<(typeof db)['EvalRun']>;
  projectId: number;
  evalPublicId: string;
  definition: EvalRunDefinition | null;
};

/**
 * Loads a run with its project. Everything a run is executed and settled by is
 * read off the run: of its Eval, only the immutable project and id are read
 * (`tests/harness/evalRunWorkerReads.test.mjs`).
 */
const loadRunContext = async (args: {
  evalRunId: number;
}): Promise<LoadedRun | null> => {
  const run = await db.EvalRun.findByPk(args.evalRunId);
  /* istanbul ignore next -- a task's FK to its run is NOT NULL with CASCADE
     delete, so a claimable task always has a live run; and the Eval FK on the
     run is NOT NULL with CASCADE too. Neither is reachable through any entry
     point — the guards exist so a future caller cannot crash the drain loop. */
  if (!run) return null;

  const evaluation = await db.Eval.findByPk(run.evalId as number, {
    attributes: ['projectId', 'publicId'],
  });
  /* istanbul ignore next -- see above. */
  if (!evaluation) return null;

  return {
    run,
    projectId: evaluation.projectId as number,
    evalPublicId: evaluation.publicId,
    definition: readEvalRunDefinition({ run }),
  };
};

/**
 * Settles `failed` a run that cannot go on: it recorded no definition, or its
 * agent was deleted. Never falls back to the Eval's current values, which may
 * name another agent or other scorers.
 */
const failUnrunnable = async (args: {
  context: LoadedRun;
  error: OwnStoredError;
}): Promise<void> => {
  const { run, projectId } = args.context;
  await discardEvalItemTasks({ evalRunId: run.id as number });
  if (!(await claimRunFinalization({ runDbId: run.id as number }))) return;
  log('failUnrunnable: run=%s %s', run.publicId, args.error.message);
  await failEvalRun({ run, projectId, error: args.error });
};

const NO_DEFINITION: OwnStoredError = {
  code: 'EVAL_RUN_DEFINITION_MISSING',
  message: 'The run recorded no definition to score it by.',
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
  // a redelivered task arrived after it had already completed, or its first
  // item failed it for having no definition.
  const { definition } = context;
  if (!isLiveRunStatus(context.run.status) || !definition) return;

  await finalizeIfUnclaimed({ ...context, settlement: definition });
};

/**
 * The run's own definition and agent, or null after failing the run when it
 * has no definition or its agent has been deleted.
 */
const loadRunnable = async (args: {
  context: LoadedRun;
}): Promise<{
  definition: EvalRunDefinition;
  agent: InstanceType<(typeof db)['Agent']>;
} | null> => {
  const { context } = args;
  const { definition, run } = context;
  if (!definition) {
    await failUnrunnable({ context, error: NO_DEFINITION });
    return null;
  }
  const agent = run.agentPublicId
    ? await agentReferences.find({
        id: run.agentPublicId,
        projectId: context.projectId,
        reach: 'project',
      })
    : null;
  if (!agent) {
    await failUnrunnable({
      context,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: `The run's agent '${run.agentPublicId ?? ''}' does not exist.`,
        meta: { agent_id: run.agentPublicId },
      },
    });
    return null;
  }
  return { definition, agent };
};

/**
 * First item of a queued run: the run is now genuinely under way. Conditional
 * on `queued`, since a sibling item may have settled the run since our read.
 * A run with probes is stamped started once they hold (`openRunProbeGate`).
 * Returns whether the run is still live.
 */
const markRunUnderWay = async (args: {
  context: LoadedRun;
}): Promise<boolean> => {
  const { run, definition } = args.context;
  if (run.status !== 'queued') return true;
  const probed = Array.isArray(definition?.criteria);
  await db.EvalRun.update(
    { status: 'running', startedAt: probed ? null : new Date() },
    { where: { id: run.id as number, status: 'queued' } }
  );
  await run.reload();
  return isLiveRunStatus(run.status);
};

/**
 * Admission's refusal of an item's step stops the run: it fails with the
 * refusal, and its other items drop as they are claimed.
 */
const stopOnRefusal = async (
  args: { run: LoadedRun['run']; projectId: number },
  fn: () => Promise<unknown>
): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    if (!isAdmissionRefusal(error)) throw error;
    await args.run.reload();
    if (!isLiveRunStatus(args.run.status)) return;
    log('stopOnRefusal: run=%s refused', args.run.publicId);
    await failEvalRun({
      run: args.run,
      projectId: args.projectId,
      error: toStoredError({
        error,
        opaque: INTERNAL_FAILURE,
        label: 'eval item',
      }),
    });
  }
};

/**
 * Executes one claimed item task.
 *
 * A run that is no longer live (cancelled between the claim and here) drops the
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
  if (!isLiveRunStatus(run.status)) {
    log(
      'handleEvalItemTask: run=%s is %s, dropping task %s',
      run.publicId,
      run.status,
      args.task.publicId
    );
    return;
  }

  if (!(await markRunUnderWay({ context }))) return;

  const runnable = await loadRunnable({ context });
  if (!runnable) return;
  const { definition, agent } = runnable;
  const gateOpen = await openRunProbeGate({
    run,
    evalPublicId: context.evalPublicId,
    projectId: context.projectId,
    definition,
    agentOutputSchema: agent.outputSchema,
    deciderVersions: run.deciderVersions,
    scorerModels: readScorerModels(run.scorerModels),
  });
  if (!gateOpen) return;
  const item = await db.DatasetItem.findByPk(args.task.datasetItemId as number);
  /* istanbul ignore next -- deleting a dataset item cascades its task away
     before it can be claimed. */
  if (!item) return;

  log(
    'handleEvalItemTask: run=%s item=%s attempt=%d',
    run.publicId,
    item.publicId,
    args.task.attempts
  );

  await stopOnRefusal({ run, projectId: context.projectId }, () => {
    return executeAndRecordItem({
      authority: parseWorkAuthority(run.authority),
      projectId: context.projectId,
      runDbId: run.id as number,
      agent,
      agentVersion: run.agentVersion as number,
      scorers: definition.scorers,
      deciderScoring: {
        versions: run.deciderVersions,
        evalId: context.evalPublicId,
        runId: run.publicId,
      },
      scorerModels: readScorerModels(run.scorerModels),
      item,
      // Re-read from the row per item: this process has no request behind it, and
      // the bag is what makes the item's generation match production.
      toolContext:
        (run.toolContext as Record<string, string> | null) ?? undefined,
    });
  });

  // The run may have been cancelled while this item was in flight. A cancelled
  // run publishes no `aggregate_scores`, so these counters are its only record
  // of the work that was really paid for.
  await run.reload();
  if (!isLiveRunStatus(run.status)) {
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
        await runAsJob(() => {
          return handleEvalItemTask({ task });
        });
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

/** Settles one stale run; whether it was settled by this call. */
const reapRun = async (args: {
  run: InstanceType<(typeof db)['EvalRun']>;
  now: Date;
}): Promise<boolean> => {
  const { run, now } = args;
  const pending = await countPendingEvalItemTasks({
    evalRunId: run.id as number,
  });
  // Still has queued work: the drain sweep owns it, not the reaper.
  if (pending > 0) return false;

  const context = await loadRunContext({ evalRunId: run.id as number });
  /* istanbul ignore next -- see `loadRunContext`. */
  if (!context) return false;

  const resultCount = await db.EvalResult.count({
    where: { evalRunId: run.id as number },
  });

  if (resultCount >= (run.itemCount as number) && context.definition) {
    log('reapAbandonedEvalRuns: finalizing stalled run=%s', run.publicId);
    return finalizeIfUnclaimed({
      ...context,
      settlement: context.definition,
      now,
    });
  }

  if (!(await claimRunFinalization({ runDbId: run.id as number, now }))) {
    return false;
  }
  log(
    'reapAbandonedEvalRuns: failing abandoned run=%s results=%d/%d',
    run.publicId,
    resultCount,
    run.itemCount
  );
  await failEvalRun({
    run: context.run,
    projectId: context.projectId,
    error: {
      code: 'EVAL_RUN_ABANDONED',
      message: `Abandoned with ${resultCount} of ${String(run.itemCount)} items recorded.`,
      meta: { result_count: resultCount, item_count: run.itemCount },
    },
  });
  return true;
};

/**
 * Recovers non-terminal runs with no outstanding work that have gone quiet past
 * the grace period. Two shapes land here and need opposite treatment:
 *
 * - Every item has a result but the run never settled — a finalize that crashed
 *   between the last ack and the update. The measurements are there, so the run
 *   is **finalized**.
 * - Items are missing — an abandoned `wait: true` run, or dropped work. Nothing
 *   will complete it, so it is settled `failed` and its lifecycle event fires,
 *   because a gate waiting on a verdict must not wait forever.
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
    if (await reapRun({ run, now })) reaped += 1;
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
