/**
 * Eval runs — the execution half of the evaluations module
 * (docs/prd-evaluations.md, Phase 1).
 *
 * A run creates **one real agent generation per dataset item** through the
 * ordinary `createGeneration` machinery, so it exercises the agent's true
 * instructions, tools, model and knowledge rather than a simulation of them;
 * each result links the generation (and through it the trace) for drill-down.
 *
 * Phase 1 is synchronous and sequential: `wait: true` is required, the dataset
 * is capped at {@link SYNC_ITEM_CAP} items, and the run reaches a terminal
 * status before the request returns. Async execution on the `RunTask` queue,
 * baseline deltas and the lifecycle webhooks arrive in Phase 2.
 *
 * The list/get side lives in `evaluationRunReads.ts`.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import type { GenerationResult } from './agentGenerationTypes';
import {
  type EvalRunRow,
  mapEvalRun,
  reloadEvalRun,
  TERMINAL_EVAL_RUN_STATUSES,
} from './evaluationRunReads';
import { getEvalRow } from './evaluations';
import {
  aggregateScores,
  resolveRunPassed,
  scoreOutput,
  type ScorerOutcome,
  validateScorers,
} from './evaluationScorers';
import type { GenerationInputMessage } from './generationInputMessages';
import { isPlainObject } from './plainObject';
import { parseActiveRelease } from './releaseAssignment';

const log = createDebug('soat:evaluations');

/**
 * The most items a synchronous run will execute.
 *
 * A run over a larger dataset is **rejected**, not truncated: scoring a subset
 * and reporting it as the run's verdict would read as a complete pass/fail over
 * the whole dataset. The `400` is stable across phases — `wait: true` never
 * becomes async — so the same request keeps returning it once the queue lands.
 */
export const SYNC_ITEM_CAP = 25;

type AgentRow = InstanceType<(typeof db)['Agent']>;
type DatasetItemRow = InstanceType<(typeof db)['DatasetItem']>;

// ── Run-start resolution ───────────────────────────────────────────────────

/**
 * Picks the single agent version the whole run executes against.
 *
 * - An explicit `agentVersion` names an archived version (how the promotion
 *   gate in docs/prd-agent-versions.md evaluates a canary before promoting it);
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
 * Phase 1 validates and persists it; the per-scorer deltas it feeds are
 * computed in Phase 2. Validating now means a caller wiring up a gate finds a
 * wrong baseline immediately rather than at the run where deltas first appear.
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

const assertSyncRunSupported = (wait: unknown): void => {
  if (wait === true) return;
  if (wait === false) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Asynchronous eval runs are not available yet; they ship with Evaluations Phase 2. Pass wait: true.'
    );
  }
  throw new DomainError(
    'VALIDATION_FAILED',
    'wait is required and must be true.'
  );
};

const assertRunnableItemCount = (args: {
  count: number;
  datasetPublicId: string;
}): void => {
  if (args.count === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Dataset '${args.datasetPublicId}' has no items; there is nothing to evaluate.`
    );
  }
  if (args.count > SYNC_ITEM_CAP) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `A synchronous run is capped at ${SYNC_ITEM_CAP} items and this dataset has ${args.count}. Reduce the dataset, or wait for asynchronous runs (Evaluations Phase 2).`
    );
  }
};

// ── Item execution ─────────────────────────────────────────────────────────

type ItemOutcome = {
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

const erroredOutcome = (
  error: string,
  generationDbId: number | null
): ItemOutcome => {
  return {
    scores: [],
    passed: false,
    errored: true,
    output: null,
    error,
    generationDbId,
  };
};

/**
 * Runs one item and scores it.
 *
 * A non-`completed` generation is an item-level **error**, never a score of 0.
 * A `requires_action` result — an agent with client-side tools pausing for tool
 * outputs — carries no `output` at all; scoring it 0 would report a behavioral
 * regression for what is really an un-evaluable target. Such an item is
 * excluded from the aggregates and counted in `erroredCount`.
 */
const runItem = async (args: {
  projectIds?: number[];
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

  const scores = scoreOutput({
    scorers: args.scorers,
    input: args.input,
    output: {
      content: generation.output.content,
      object: generation.output.object,
    },
    expectedOutput: args.expectedOutput,
    itemMetadata: args.itemMetadata,
    agentOutputSchema: args.agentOutputSchema,
  });

  return {
    scores,
    passed: scores.every((outcome) => {
      return outcome.passed;
    }),
    errored: false,
    output: generation.output.content,
    error: null,
    generationDbId,
  };
};

/**
 * Executes every item in order, writing one `EvalResult` per item as it goes.
 *
 * Sequential by design in Phase 1 — the item cap bounds the worst case, and
 * bounded parallelism is an additive optimization with no contract change.
 */
const executeItems = async (args: {
  projectIds?: number[];
  runDbId: number;
  agent: AgentRow;
  agentVersion: number;
  scorers: unknown[];
  items: DatasetItemRow[];
}): Promise<ItemOutcome[]> => {
  const outcomes: ItemOutcome[] = [];

  for (const item of args.items) {
    const outcome = await runItem({
      projectIds: args.projectIds,
      agentPublicId: args.agent.publicId,
      agentVersion: args.agentVersion,
      agentOutputSchema: args.agent.outputSchema,
      scorers: args.scorers,
      input: item.input,
      expectedOutput: item.expectedOutput,
      itemMetadata: item.metadata,
    });

    await db.EvalResult.create({
      evalRunId: args.runDbId,
      datasetItemId: item.id as number,
      // Frozen at run time: editing or deleting the item afterwards can no
      // longer rewrite what this run was scored against.
      input: item.input,
      expectedOutput: item.expectedOutput,
      generationId: outcome.generationDbId,
      output: outcome.output,
      scores: outcome.scores,
      passed: outcome.passed,
      error: outcome.error,
    });

    outcomes.push(outcome);
  }

  return outcomes;
};

const finalizeRun = async (args: {
  run: InstanceType<(typeof db)['EvalRun']>;
  outcomes: ItemOutcome[];
  passThreshold: number | null;
}): Promise<void> => {
  const aggregate = aggregateScores({ results: args.outcomes });

  await args.run.update({
    status: 'completed',
    aggregateScores: aggregate,
    passed: resolveRunPassed({
      passThreshold: args.passThreshold,
      aggregate,
    }),
    completedCount: args.outcomes.filter((outcome) => {
      return !outcome.errored;
    }).length,
    erroredCount: args.outcomes.filter((outcome) => {
      return outcome.errored;
    }).length,
    finishedAt: new Date(),
  });
};

// ── Starting a run ─────────────────────────────────────────────────────────

export const startEvalRun = async (args: {
  projectIds?: number[];
  evalId: string;
  wait: unknown;
  agentVersion?: unknown;
  baselineRunId?: unknown;
}): Promise<ReturnType<typeof mapEvalRun>> => {
  log('startEvalRun: evalId=%s', args.evalId);

  assertSyncRunSupported(args.wait);

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
  });

  const agentVersion = await resolveRunAgentVersion({
    agent,
    requestedVersion: args.agentVersion,
  });
  const baselineRunDbId = await resolveBaselineRun({
    evalDbId: evaluation.id as number,
    baselineRunId: args.baselineRunId,
  });

  const run = await db.EvalRun.create({
    evalId: evaluation.id as number,
    agentVersion,
    status: 'running',
    baselineRunId: baselineRunDbId,
    itemCount: items.length,
    startedAt: new Date(),
  });

  log(
    'startEvalRun: run=%s items=%d agentVersion=%d',
    run.publicId,
    items.length,
    agentVersion
  );

  let outcomes: ItemOutcome[];
  try {
    outcomes = await executeItems({
      projectIds: args.projectIds,
      runDbId: run.id as number,
      agent,
      agentVersion,
      scorers: Array.isArray(evaluation.scorers) ? evaluation.scorers : [],
      items,
    });
  } catch (error) {
    // An infrastructure failure (not an item's generation failing — that is
    // caught per item) leaves the run recorded as `failed` rather than stuck
    // `running`, then propagates.
    await run.update({ status: 'failed', finishedAt: new Date() });
    log('startEvalRun: run=%s failed: %s', run.publicId, errorMessage(error));
    throw error;
  }

  await finalizeRun({
    run,
    outcomes,
    passThreshold:
      evaluation.passThreshold === null
        ? null
        : Number(evaluation.passThreshold),
  });

  return mapEvalRun(await reloadEvalRun(run as EvalRunRow));
};
