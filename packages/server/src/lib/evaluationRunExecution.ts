/**
 * Executing and finalizing an eval run's items (the evaluations module doc).
 *
 * Both run modes funnel through here: a synchronous run loops over the items
 * in-process, and a queued run has one worker task per item. That is deliberate —
 * a second execution path is how the two modes drift into scoring differently,
 * which would make a `wait: true` run and a `wait: false` run of the same Eval
 * incomparable.
 *
 * Aggregation reads the **persisted** `EvalResult` rows rather than in-memory
 * outcomes, for the same reason: the queued path has no in-memory list to roll
 * up, and a DB-driven finalize is the only version that is correct for a run
 * assembled by several workers.
 */
import createDebug from 'debug';

import { db } from '../db';
import { createGeneration } from './agentGeneration';
import type { GenerationResult } from './agentGenerationTypes';
import { computeBaselineComparison } from './evaluationDeltas';
import { emitEvalRunEvent, EVAL_RUN_COMPLETED_EVENT } from './evaluationEvents';
import { runJudgeCompletion } from './evaluationJudge';
import {
  type AggregateScores,
  aggregateScores,
  resolveRunPassed,
} from './evaluationScorerAggregation';
import { scoreOutput, type ScorerOutcome } from './evaluationScorers';
import { runToolScorerCall } from './evaluationToolScorer';
import type { GenerationInputMessage } from './generationInputMessages';

const log = createDebug('soat:evaluations');

/**
 * Usage attribution for an eval run's item generations, so verification spend is
 * separable from the spend serving real users (usage module — Coverage).
 */
export const EVAL_USAGE_SOURCE = 'eval';

type AgentRow = InstanceType<(typeof db)['Agent']>;
type DatasetItemRow = InstanceType<(typeof db)['DatasetItem']>;
type EvalRunRowInstance = InstanceType<(typeof db)['EvalRun']>;

export type ItemOutcome = {
  scores: ScorerOutcome[];
  passed: boolean;
  errored: boolean;
  output: string | null;
  error: string | null;
  generationDbId: number | null;
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const generationDbIdOf = async (publicId: string): Promise<number | null> => {
  const row = await db.Generation.findOne({
    where: { publicId },
    attributes: ['id'],
  });
  return row ? (row.id as number) : null;
};

/**
 * An item that could not be scored.
 *
 * `output` is whatever the agent actually produced, which is `null` only when
 * there genuinely is none — the generation threw, or did not complete. A scorer
 * that failed *after* a good generation passes the real text: the answer exists,
 * it cost money, and it is the one thing needed to debug why the scorer choked
 * on it. The item is still errored, never scored 0.
 */
const erroredOutcome = (
  error: string,
  generationDbId: number | null,
  output: string | null = null
): ItemOutcome => {
  return {
    scores: [],
    passed: false,
    errored: true,
    output,
    error,
    generationDbId,
  };
};

/**
 * The I/O runners the scorer kernel needs, bound to the run's project: judge
 * completions and tool scorer calls. Injected into `scoreOutput` so the kernel
 * itself stays pure.
 */
const buildScorerRunners = (args: { projectId: number }) => {
  return {
    runJudge: (judge: {
      scorer: Record<string, unknown>;
      input: unknown;
      output: string;
      expected: string | null;
    }) => {
      return runJudgeCompletion({ projectId: args.projectId, ...judge });
    },
    runToolScorer: (call: {
      scorer: Record<string, unknown>;
      context: Record<string, unknown>;
    }) => {
      return runToolScorerCall({ projectId: args.projectId, ...call });
    },
  };
};

/**
 * Runs one item and scores it.
 *
 * A non-`completed` generation is an item-level **error**, never a score of 0.
 * A `requires_action` result — an agent with client-side tools pausing for tool
 * outputs — carries no `output` at all; scoring it 0 would report a behavioral
 * regression for what is really an un-evaluable target. The same rule covers a
 * judge that fails to answer: `scoreOutput` propagates the rejection and the item
 * is recorded as errored, excluded from the aggregates and counted in
 * `erroredCount`.
 */
export const runEvalItem = async (args: {
  projectIds?: number[];
  projectId: number;
  agentPublicId: string;
  agentVersion: number;
  agentOutputSchema: unknown;
  scorers: unknown[];
  input: unknown;
  expectedOutput: string | null;
  itemMetadata: unknown;
}): Promise<ItemOutcome> => {
  let generation: GenerationResult | ReadableStream;
  try {
    generation = await createGeneration({
      projectIds: args.projectIds,
      agentId: args.agentPublicId,
      messages: args.input as GenerationInputMessage[],
      // `stream: false` makes the `ReadableStream` arm of the return type
      // unreachable; the guard below keeps the narrowing honest.
      stream: false,
      pinnedAgentVersion: args.agentVersion,
      source: EVAL_USAGE_SOURCE,
    });
  } catch (error) {
    return erroredOutcome(errorMessage(error), null);
  }

  /* istanbul ignore next -- `stream: false` above means createGeneration never
     returns a stream here; the branch exists only to narrow the union. */
  if (generation instanceof ReadableStream) {
    return erroredOutcome(
      'Generation returned a stream; eval runs require stream=false.',
      null
    );
  }

  const generationDbId = await generationDbIdOf(generation.id);

  if (generation.status !== 'completed' || !generation.output) {
    return erroredOutcome(
      `Generation did not complete (status '${generation.status}'); the item could not be evaluated.`,
      generationDbId
    );
  }

  const output = {
    content: generation.output.content,
    object: generation.output.object,
  };

  let scores: ScorerOutcome[];
  try {
    scores = await scoreOutput({
      scorers: args.scorers,
      input: args.input,
      output,
      expectedOutput: args.expectedOutput,
      itemMetadata: args.itemMetadata,
      agentOutputSchema: args.agentOutputSchema,
      ...buildScorerRunners({ projectId: args.projectId }),
    });
  } catch (error) {
    // A scorer that could not produce a verdict (a judge call failing, a
    // malformed judge reply) is an item error — the agent's answer was never
    // graded, so recording 0 would fabricate a regression. The generation and
    // its output are both kept: they happened and cost money, and the output is
    // what the failed scorer was looking at.
    return erroredOutcome(
      `Scoring failed: ${errorMessage(error)}`,
      generationDbId,
      output.content
    );
  }

  return {
    scores,
    passed: scores.every((outcome) => {
      return outcome.passed;
    }),
    errored: false,
    output: output.content,
    error: null,
    generationDbId,
  };
};

/**
 * Runs one item and persists its result.
 *
 * Idempotent on the unique `(eval_run_id, dataset_item_id)` index: a redelivered
 * queue task overwrites the row it wrote before rather than adding a second one,
 * so at-least-once delivery cannot double-count an item. Returns whether a new
 * result row was created, which is what advances the run's counters exactly once
 * per item.
 */
export const executeAndRecordItem = async (args: {
  projectIds?: number[];
  projectId: number;
  runDbId: number;
  agent: AgentRow;
  agentVersion: number;
  scorers: unknown[];
  item: DatasetItemRow;
}): Promise<ItemOutcome> => {
  const outcome = await runEvalItem({
    projectIds: args.projectIds,
    projectId: args.projectId,
    agentPublicId: args.agent.publicId,
    agentVersion: args.agentVersion,
    agentOutputSchema: args.agent.outputSchema,
    scorers: args.scorers,
    input: args.item.input,
    expectedOutput: args.item.expectedOutput,
    itemMetadata: args.item.metadata,
  });

  const columns = {
    // Frozen at run time: editing or deleting the item afterwards can no longer
    // rewrite what this run was scored against.
    input: args.item.input,
    expectedOutput: args.item.expectedOutput,
    generationId: outcome.generationDbId,
    output: outcome.output,
    scores: outcome.scores,
    passed: outcome.passed,
    error: outcome.error,
  };

  const [result, created] = await db.EvalResult.findOrCreate({
    where: {
      evalRunId: args.runDbId,
      datasetItemId: args.item.id as number,
    },
    defaults: {
      evalRunId: args.runDbId,
      datasetItemId: args.item.id as number,
      ...columns,
    },
  });

  if (!created) {
    // A redelivered task: the item ran again, so the fresher outcome replaces
    // the older one in place. One row per item per run, always.
    await result.update(columns);
  }

  return outcome;
};

/**
 * Recomputes a run's `completedCount` / `erroredCount` from its persisted
 * results.
 *
 * Derived from the rows rather than incremented, which makes it idempotent:
 * several workers finishing at once, or a redelivered task, converge on the same
 * numbers instead of double-counting.
 */
export const recountEvalRunProgress = async (args: {
  run: EvalRunRowInstance;
}): Promise<void> => {
  const results = await db.EvalResult.findAll({
    where: { evalRunId: args.run.id as number },
    attributes: ['error'],
  });
  const erroredCount = results.filter((row) => {
    return row.error !== null;
  }).length;

  await args.run.update({
    completedCount: results.length - erroredCount,
    erroredCount,
  });
};

// ── Finalization ───────────────────────────────────────────────────────────

type ResultRow = InstanceType<(typeof db)['EvalResult']>;

/**
 * `scores` is a NOT NULL JSONB column only ever written from `scoreOutput`, so it
 * is always an array — there is no absent-value case to defend against.
 */
const resultScores = (row: ResultRow): ScorerOutcome[] => {
  return row.scores as ScorerOutcome[];
};

const toComparable = (row: ResultRow) => {
  return {
    datasetItemId: row.datasetItemId,
    scores: resultScores(row),
    errored: row.error !== null,
    passed: row.passed,
  };
};

/** Loads the baseline's results and computes the comparison, or null if absent. */
const buildBaselineComparison = async (args: {
  baselineRunDbId: number | null;
  current: ResultRow[];
}): Promise<AggregateScores['baseline']> => {
  if (args.baselineRunDbId === null) return undefined;

  const baselineRun = await db.EvalRun.findByPk(args.baselineRunDbId, {
    attributes: ['id', 'publicId'],
  });
  /* istanbul ignore next -- the FK is ON DELETE SET NULL, so a surviving id
     always resolves to a row. */
  if (!baselineRun) return undefined;

  const baselineResults = await db.EvalResult.findAll({
    where: { evalRunId: args.baselineRunDbId },
  });

  return computeBaselineComparison({
    baselineRunPublicId: baselineRun.publicId,
    current: args.current.map(toComparable),
    baseline: baselineResults.map(toComparable),
  });
};

/**
 * Rolls a run's persisted results up to its terminal state and fires
 * `eval_run.completed`.
 *
 * The single finalize path for both run modes, and the only place the completion
 * event is emitted — which is what makes "exactly once per terminal run" a
 * property of the code rather than a convention two paths have to keep.
 */
export const finalizeEvalRun = async (args: {
  run: EvalRunRowInstance;
  evalPublicId: string;
  projectId: number;
  passThreshold: number | null;
}): Promise<void> => {
  const results = await db.EvalResult.findAll({
    where: { evalRunId: args.run.id as number },
  });

  const aggregate: AggregateScores = aggregateScores({
    results: results.map((row) => {
      return {
        scores: resultScores(row),
        passed: row.passed,
        errored: row.error !== null,
      };
    }),
  });

  const baseline = await buildBaselineComparison({
    baselineRunDbId: args.run.baselineRunId,
    current: results,
  });
  if (baseline) aggregate.baseline = baseline;

  const passed = resolveRunPassed({
    passThreshold: args.passThreshold,
    aggregate,
  });

  const erroredCount = results.filter((row) => {
    return row.error !== null;
  }).length;

  await args.run.update({
    status: 'completed',
    aggregateScores: aggregate,
    passed,
    completedCount: results.length - erroredCount,
    erroredCount,
    finishedAt: new Date(),
  });

  log(
    'finalizeEvalRun: run=%s scored=%d errored=%d passed=%s',
    args.run.publicId,
    aggregate.scored_item_count,
    erroredCount,
    passed
  );

  emitEvalRunEvent({
    event: EVAL_RUN_COMPLETED_EVENT,
    projectId: args.projectId,
    evalPublicId: args.evalPublicId,
    runPublicId: args.run.publicId,
    passed,
    aggregateScores: aggregate,
  });
};

/**
 * Settles a run that could not be executed at all (an infrastructure failure,
 * not an item's generation failing — that is caught per item) and fires
 * `eval_run.failed`.
 *
 * A gate consumer must hear about this: a run that silently stayed `running`
 * forever is a promotion that never resolves either way.
 */
export const failEvalRun = async (args: {
  run: EvalRunRowInstance;
  evalPublicId: string;
  projectId: number;
  reason: string;
}): Promise<void> => {
  log('failEvalRun: run=%s reason=%s', args.run.publicId, args.reason);

  await args.run.update({ status: 'failed', finishedAt: new Date() });

  emitEvalRunEvent({
    event: 'eval_run.failed',
    projectId: args.projectId,
    evalPublicId: args.evalPublicId,
    runPublicId: args.run.publicId,
    passed: null,
    aggregateScores: null,
  });
};

/**
 * Wins the exclusive right to settle a run, atomically.
 *
 * Several workers can finish a run's last items at the same instant and each
 * observe an empty task queue, so "is it done?" must not be a read followed by a
 * write. This is one conditional `UPDATE` on `finished_at IS NULL`: exactly one
 * caller sees a row count of 1 and goes on to finalize, and the rest see 0 and
 * stop. Without it a run would fire `eval_run.completed` more than once — and a
 * promotion gate that receives the same verdict twice is a gate that can act
 * twice.
 *
 * Guarding on `finished_at` rather than on a `finalizing` status keeps the
 * public status vocabulary unchanged; the column is already written by every
 * terminal transition and read by nothing that branches on it.
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
 * let `eval_run.completed` fire twice for one run.
 */
export const finalizeIfUnclaimed = async (args: {
  run: EvalRunRowInstance;
  evalPublicId: string;
  projectId: number;
  passThreshold: number | null;
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

  await finalizeEvalRun({
    run: args.run,
    evalPublicId: args.evalPublicId,
    projectId: args.projectId,
    passThreshold: args.passThreshold,
  });
  return true;
};
