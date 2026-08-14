/**
 * Starting, and stopping, eval runs (the evaluations module doc).
 *
 * A run creates **one real agent generation per dataset item** through the
 * ordinary `createGeneration` machinery, so it exercises the agent's true
 * instructions, tools, model and knowledge rather than a simulation of them;
 * each result links the generation (and through it the trace) for drill-down.
 *
 * Two modes, one execution path (`evaluationRunExecution.ts`):
 *
 * - `wait: true` — synchronous and sequential, dataset capped at
 *   {@link SYNC_ITEM_CAP} items, terminal before the request returns.
 * - `wait: false` — one queued task per item, answered `queued` immediately.
 *   The worker executes items and the last one to finish finalizes the run.
 *
 * The list/get side lives in `evaluationRunReads.ts`.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { discardEvalItemTasks, enqueueEvalItemTasks } from './evaluationQueue';
import {
  executeAndRecordItem,
  failEvalRun,
  finalizeEvalRun,
  recountEvalRunProgress,
} from './evaluationRunExecution';
import {
  type EvalRunRow,
  mapEvalRun,
  reloadEvalRun,
  TERMINAL_EVAL_RUN_STATUSES,
} from './evaluationRunReads';
import { getEvalRow } from './evaluations';
import { scorerList, validateScorers } from './evaluationScorers';
import { kickEvalWorker } from './evaluationWorker';
import { isPlainObject } from './plainObject';
import { parseActiveRelease } from './releaseAssignment';

const log = createDebug('soat:evaluations');

/**
 * The most items a **synchronous** run will execute.
 *
 * A `wait: true` run over a larger dataset is **rejected**, not truncated:
 * scoring a subset and reporting it as the run's verdict would read as a complete
 * pass/fail over the whole dataset. The `400` is stable across phases —
 * `wait: true` never becomes async — and an over-cap dataset is exactly what
 * `wait: false` is for.
 */
export const SYNC_ITEM_CAP = 25;

type AgentRow = InstanceType<(typeof db)['Agent']>;

// ── Run-start resolution ───────────────────────────────────────────────────

/**
 * Picks the single agent version the whole run executes against.
 *
 * - An explicit `agentVersion` names an archived version (how the eval-gated
 *   promotion in the agents module evaluates a canary before promoting it);
 *   an unknown one is a `400`.
 * - Otherwise the run follows the agent's **stable** side when a release is in
 *   effect, and the live draft version when none is — never the canary, and
 *   never a per-item random assignment.
 */
export const resolveRunAgentVersion = async (args: {
  agent: AgentRow;
  requestedVersion?: unknown;
}): Promise<number> => {
  const liveVersion = args.agent.version ?? 1;

  if (args.requestedVersion === undefined || args.requestedVersion === null) {
    const release = parseActiveRelease(args.agent.activeRelease);
    return release ? release.stable_version : liveVersion;
  }

  if (
    typeof args.requestedVersion !== 'number' ||
    !Number.isInteger(args.requestedVersion) ||
    args.requestedVersion < 1
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'agent_version must be a positive integer naming an archived agent version.'
    );
  }

  const archived = await db.AgentVersion.findOne({
    where: { agentId: args.agent.id as number, version: args.requestedVersion },
    attributes: ['id'],
  });
  if (!archived) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `agent_version ${args.requestedVersion} has no archived config for agent '${args.agent.publicId}'.`
    );
  }

  return args.requestedVersion;
};

/**
 * Resolves the optional baseline link.
 *
 * Validated at start rather than at finalize so a caller wiring up a gate finds a
 * wrong baseline immediately, instead of at the end of a run that already spent
 * the money.
 */
const resolveBaselineRun = async (args: {
  evalDbId: number;
  baselineRunId?: unknown;
}): Promise<number | null> => {
  if (args.baselineRunId === undefined || args.baselineRunId === null) {
    return null;
  }
  if (typeof args.baselineRunId !== 'string') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'baseline_run_id must be an eval run id.'
    );
  }

  const baseline = await db.EvalRun.findOne({
    where: { publicId: args.baselineRunId, evalId: args.evalDbId },
  });
  if (!baseline) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `baseline_run_id '${args.baselineRunId}' is not a run of this eval.`
    );
  }
  if (!TERMINAL_EVAL_RUN_STATUSES.includes(baseline.status)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `baseline_run_id '${args.baselineRunId}' has not finished (status '${baseline.status}').`
    );
  }

  return baseline.id as number;
};

/**
 * Reads the `wait` flag.
 *
 * Defaulting to `false` — matching `orchestrations.yaml` — is safe now and was
 * not in Phase 1: a caller who omits `wait` gets a `queued` run, which is what
 * omitting it will always mean from here on. Phase 1 required the field
 * precisely so this default could be introduced without any existing caller's
 * behavior changing (the evaluations module doc).
 */
const parseWait = (wait: unknown): boolean => {
  if (wait === undefined || wait === null) return false;
  if (typeof wait !== 'boolean') {
    throw new DomainError('VALIDATION_FAILED', 'wait must be a boolean.');
  }
  return wait;
};

const assertRunnableItemCount = (args: {
  count: number;
  datasetPublicId: string;
  wait: boolean;
}): void => {
  if (args.count === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Dataset '${args.datasetPublicId}' has no items; there is nothing to evaluate.`
    );
  }
  if (args.wait && args.count > SYNC_ITEM_CAP) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `A synchronous run is capped at ${SYNC_ITEM_CAP} items and this dataset has ${args.count}. Reduce the dataset, or start the run with wait: false to execute it on the queue.`
    );
  }
};

// ── Starting a run ─────────────────────────────────────────────────────────

type RunPlan = {
  evaluation: Awaited<ReturnType<typeof getEvalRow>>;
  agent: AgentRow;
  items: Array<InstanceType<(typeof db)['DatasetItem']>>;
  agentVersion: number;
  baselineRunDbId: number | null;
};

/**
 * Everything a run needs resolved and validated **before** a row exists: the
 * Eval and its agent, the scorers re-checked against the agent as it is now, the
 * items, the pinned version, and the baseline link.
 *
 * All of it up front so a rejected request creates no `EvalRun` at all — a
 * `failed` row for a request that never ran would pollute the run history a gate
 * reads.
 */
const planRun = async (args: {
  projectIds?: number[];
  evalId: string;
  wait: boolean;
  agentVersion?: unknown;
  baselineRunId?: unknown;
}): Promise<RunPlan> => {
  const evaluation = await getEvalRow({
    projectIds: args.projectIds,
    id: args.evalId,
  });
  const { agent, dataset } = evaluation;

  /* istanbul ignore next -- both FKs are NOT NULL and the includes always load
     them; the narrowing keeps the reads below type-safe. */
  if (!agent || !dataset) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Eval '${args.evalId}' is missing its agent or dataset.`
    );
  }

  // Authoritative re-check: the agent's `output_schema` is mutable, so an Eval
  // that validated at create time can have stopped being runnable since.
  const scorerError = validateScorers({
    scorers: evaluation.scorers,
    agentHasOutputSchema: isPlainObject(agent.outputSchema),
  });
  if (scorerError) throw new DomainError('VALIDATION_FAILED', scorerError);

  const items = await db.DatasetItem.findAll({
    where: { datasetId: dataset.id as number },
    order: [['createdAt', 'ASC']],
  });
  assertRunnableItemCount({
    count: items.length,
    datasetPublicId: dataset.publicId,
    wait: args.wait,
  });

  return {
    evaluation,
    agent,
    items,
    agentVersion: await resolveRunAgentVersion({
      agent,
      requestedVersion: args.agentVersion,
    }),
    baselineRunDbId: await resolveBaselineRun({
      evalDbId: evaluation.id as number,
      baselineRunId: args.baselineRunId,
    }),
  };
};

/** Executes every item in order, then settles the run. */
const executeSyncRun = async (args: {
  projectIds?: number[];
  plan: RunPlan;
  run: InstanceType<(typeof db)['EvalRun']>;
}): Promise<void> => {
  const { plan, run } = args;
  const projectId = plan.evaluation.projectId as number;

  try {
    // Sequential by design: the item cap bounds the worst case, and bounded
    // parallelism is an additive optimization with no contract change. A caller
    // that wants concurrency uses `wait: false`.
    for (const item of plan.items) {
      await executeAndRecordItem({
        projectIds: args.projectIds,
        projectId,
        runDbId: run.id as number,
        agent: plan.agent,
        agentVersion: plan.agentVersion,
        scorers: scorerList(plan.evaluation.scorers),
        item,
      });
    }
  } catch (error) {
    // An infrastructure failure (not an item's generation failing — that is
    // caught per item) leaves the run recorded as `failed` rather than stuck
    // `running`, fires the lifecycle event, then propagates.
    await failEvalRun({
      run,
      evalPublicId: plan.evaluation.publicId,
      projectId,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await finalizeEvalRun({
    run,
    evalPublicId: plan.evaluation.publicId,
    projectId,
    passThreshold:
      plan.evaluation.passThreshold === null
        ? null
        : Number(plan.evaluation.passThreshold),
  });
};

export const startEvalRun = async (args: {
  projectIds?: number[];
  evalId: string;
  wait: unknown;
  agentVersion?: unknown;
  baselineRunId?: unknown;
  /**
   * Public id of the trigger firing this run, when a trigger started it. Set
   * only by `triggerDispatch`; a run started through the REST route has no
   * schedule origin to record.
   */
  triggerId?: string;
}): Promise<ReturnType<typeof mapEvalRun>> => {
  const wait = parseWait(args.wait);
  log('startEvalRun: evalId=%s wait=%s', args.evalId, wait);

  const plan = await planRun({ ...args, wait });

  const run = await db.EvalRun.create({
    evalId: plan.evaluation.id as number,
    agentVersion: plan.agentVersion,
    // A queued run has not started yet — `startedAt` is stamped by the first
    // worker that picks up one of its items.
    status: wait ? 'running' : 'queued',
    baselineRunId: plan.baselineRunDbId,
    triggerId: args.triggerId ?? null,
    itemCount: plan.items.length,
    startedAt: wait ? new Date() : null,
  });

  log(
    'startEvalRun: run=%s items=%d agentVersion=%d wait=%s',
    run.publicId,
    plan.items.length,
    plan.agentVersion,
    wait
  );

  if (wait) {
    await executeSyncRun({ projectIds: args.projectIds, plan, run });
  } else {
    await enqueueEvalItemTasks({
      evalRunId: run.id as number,
      datasetItemIds: plan.items.map((item) => {
        return item.id as number;
      }),
    });
    // Lets a single-process deployment drive the queue without a separate
    // worker, exactly as `enqueueRunTask` callers do for orchestrations.
    kickEvalWorker();
  }

  return mapEvalRun(await reloadEvalRun(run as EvalRunRow));
};

// ── Canceling a run ────────────────────────────────────────────────────────

/**
 * Cancels a queued or running run.
 *
 * Drops the run's outstanding item tasks so it stops consuming provider budget
 * on the next worker tick, and settles the row `canceled` with whatever it had
 * already scored. Results already written are left exactly as they are — they are
 * real measurements of real generations that were really paid for.
 *
 * `aggregate_scores` is deliberately **not** computed for a canceled run: a
 * partial roll-up presented in the same field a completed run uses is the
 * "subset reported as a whole-dataset verdict" failure the sync cap exists to
 * prevent. `completed_count` / `errored_count` still report what ran, and the
 * per-item results remain readable.
 */
export const cancelEvalRun = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
}): Promise<ReturnType<typeof mapEvalRun>> => {
  log('cancelEvalRun: evalId=%s runId=%s', args.evalId, args.runId);

  const evaluation = await getEvalRow({
    projectIds: args.projectIds,
    id: args.evalId,
  });

  const run = await db.EvalRun.findOne({
    where: { publicId: args.runId, evalId: evaluation.id as number },
  });
  if (!run) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Eval run '${args.runId}' not found.`
    );
  }
  if (TERMINAL_EVAL_RUN_STATUSES.includes(run.status)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Eval run '${args.runId}' has already finished (status '${run.status}').`
    );
  }

  await discardEvalItemTasks({ evalRunId: run.id as number });

  await run.update({ status: 'canceled', finishedAt: new Date() });

  // Counts what has landed so far. Items already claimed by a worker are past
  // its liveness check and keep writing results after this point; each of those
  // late writes recounts, so the numbers converge on what really ran instead of
  // freezing at the cancel instant.
  await recountEvalRunProgress({ run });

  return mapEvalRun(await reloadEvalRun(run as EvalRunRow));
};
