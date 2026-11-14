/**
 * Settling an eval run (the evaluations module doc — Pass semantics): rolling
 * its persisted results up, reading the verdict, and firing the lifecycle event
 * exactly once.
 *
 * Every figure a settle reads comes from the run itself, its results and its
 * stored definition, never from the Eval, which may have been edited since the
 * run started.
 */
import createDebug from 'debug';

import { db } from '../db';
import {
  emitEvalRunEvent,
  EVAL_RUN_COMPLETED_EVENT,
  EVAL_RUN_FAILED_EVENT,
} from './evaluationEvents';
import { buildRunAggregate } from './evaluationRunAggregate';
import {
  type EvalRunDefinition,
  readRunDefinition,
} from './evaluationRunDefinition';
import type { AggregateScores } from './evaluationScorerAggregation';
import {
  intervalVerdict,
  type Verdict,
  type VerdictReason,
  worstVerdict,
} from './evaluationVerdict';

const log = createDebug('soat:evaluations');

type EvalRunRowInstance = InstanceType<(typeof db)['EvalRun']>;

/** Each required group judged on its own interval; a missing one scored nothing. */
const requiredGroupReasons = (args: {
  groups: string[];
  aggregate: AggregateScores;
  threshold: number;
}): VerdictReason[] => {
  return args.groups.map((name) => {
    return {
      scope: { kind: 'group', name },
      ...intervalVerdict({
        interval:
          args.aggregate.grouping?.groups[name]?.pass_rate_interval ?? null,
        threshold: args.threshold,
      }),
    };
  });
};

/**
 * The run's verdict and why: the run's own interval against the threshold,
 * then each group `evidence.required_groups` names, judged by the same rule on
 * its own interval. The verdict is the worst of them; groups the evidence does
 * not require stay report-only. Null without a threshold: the Eval reports
 * scores without gating on them.
 */
export const runVerdict = (args: {
  definition: EvalRunDefinition | null;
  aggregate: AggregateScores;
}): { verdict: Verdict | null; reasons: VerdictReason[] | null } => {
  const threshold = args.definition?.pass_threshold ?? null;
  if (threshold === null) return { verdict: null, reasons: null };

  const reasons: VerdictReason[] = [
    {
      scope: { kind: 'run' },
      ...intervalVerdict({
        interval: args.aggregate.pass_rate_interval,
        threshold,
      }),
    },
    ...requiredGroupReasons({
      groups: args.definition?.evidence?.required_groups ?? [],
      aggregate: args.aggregate,
      threshold,
    }),
  ];
  return { verdict: worstVerdict(reasons), reasons };
};

/**
 * Rolls a run's persisted results up to its terminal state and fires
 * `eval_runs.completed`.
 *
 * The single finalize path for both run modes, and the only place the completion
 * event is emitted — which is what makes "exactly once per terminal run" a
 * property of the code rather than a convention two paths have to keep.
 */
export const finalizeEvalRun = async (args: {
  run: EvalRunRowInstance;
  projectId: number;
}): Promise<void> => {
  const definition = readRunDefinition(args.run);
  const results = await db.EvalResult.findAll({
    where: { evalRunId: args.run.id as number },
  });

  const aggregate = await buildRunAggregate({
    run: args.run,
    groupBy: definition?.group_by ?? null,
    results,
  });

  const { verdict, reasons } = runVerdict({ definition, aggregate });

  const erroredCount = results.filter((row) => {
    return row.error !== null;
  }).length;

  await args.run.update({
    status: 'completed',
    aggregateScores: aggregate,
    verdict,
    verdictReasons: reasons,
    // The bag is only needed while items execute, and a finished run is a
    // report that outlives the work.
    toolContext: null,
    completedCount: results.length - erroredCount,
    erroredCount,
    finishedAt: new Date(),
  });

  log(
    'finalizeEvalRun: run=%s scored=%d errored=%d verdict=%s',
    args.run.publicId,
    aggregate.scored_item_count,
    erroredCount,
    verdict
  );

  await emitEvalRunEvent({
    event: EVAL_RUN_COMPLETED_EVENT,
    projectId: args.projectId,
    run: args.run,
  });
};

/**
 * Settles a run that could not be executed at all (an infrastructure failure,
 * not an item's generation failing — that is caught per item) and fires
 * `eval_runs.failed`.
 *
 * A gate consumer must hear about this: a run that silently stayed `running`
 * forever is a promotion that never resolves either way.
 */
export const failEvalRun = async (args: {
  run: EvalRunRowInstance;
  projectId: number;
  reason: string;
}): Promise<void> => {
  log('failEvalRun: run=%s reason=%s', args.run.publicId, args.reason);

  await args.run.update({
    status: 'failed',
    finishedAt: new Date(),
    toolContext: null,
  });

  await emitEvalRunEvent({
    event: EVAL_RUN_FAILED_EVENT,
    projectId: args.projectId,
    run: args.run,
  });
};

/**
 * Wins the exclusive right to settle a run, atomically.
 *
 * Several workers can finish a run's last items at the same instant and each
 * observe an empty task queue, so "is it done?" must not be a read followed by
 * a write. This is one conditional `UPDATE` on `finished_at IS NULL`: exactly
 * one caller sees a row count of 1. Without it a run would fire
 * `eval_runs.completed` more than once — and a promotion gate that receives the
 * same verdict twice can act twice.
 *
 * Guarding on `finished_at` rather than a `finalizing` status keeps the public
 * status vocabulary unchanged.
 */
export const claimRunFinalization = async (args: {
  runDbId: number;
  now?: Date;
}): Promise<boolean> => {
  const [affected] = await db.EvalRun.update(
    { finishedAt: args.now ?? new Date() },
    { where: { id: args.runDbId, finishedAt: null } }
  );
  return affected === 1;
};

/**
 * Finalizes a run **iff** this caller wins the settle claim; returns whether it
 * did.
 *
 * The one place the claim and the finalize are paired, so neither worker call
 * site can drift into finalizing without claiming first — which is what would
 * let `eval_runs.completed` fire twice for one run.
 */
export const finalizeIfUnclaimed = async (args: {
  run: EvalRunRowInstance;
  projectId: number;
  now?: Date;
}): Promise<boolean> => {
  if (
    !(await claimRunFinalization({
      runDbId: args.run.id as number,
      now: args.now,
    }))
  ) {
    log('finalizeIfUnclaimed: run=%s already settling', args.run.publicId);
    return false;
  }

  await finalizeEvalRun({ run: args.run, projectId: args.projectId });
  return true;
};
