/**
 * The read side of eval runs: row shapes, wire mappers, and the list/get
 * endpoints.
 *
 * Split from `evaluationRuns.ts` so the execution path there stays about
 * *running* an eval. Both halves share these mappers, which keeps one
 * definition of the run and result wire shapes.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { getEvalRow } from './evaluations';
import type { ResourceIncludes } from './modelIncludes';
import { type Page, paginatedList } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:evaluations');

/** Terminal statuses — the only ones a baseline may be taken from. */
export const TERMINAL_EVAL_RUN_STATUSES: readonly string[] = [
  'completed',
  'failed',
  'cancelled',
];

export type EvalRunRow = InstanceType<(typeof db)['EvalRun']> & {
  eval?: InstanceType<(typeof db)['Eval']>;
  baselineRun?: InstanceType<(typeof db)['EvalRun']> | null;
};

export type EvalResultRow = InstanceType<(typeof db)['EvalResult']> & {
  evalRun?: InstanceType<(typeof db)['EvalRun']>;
  datasetItem?: InstanceType<(typeof db)['DatasetItem']> | null;
  generation?: InstanceType<(typeof db)['Generation']> | null;
};

export const mapEvalRun = (run: EvalRunRow) => {
  return {
    id: run.publicId,
    eval_id: run.eval?.publicId,
    agent_id: run.agentPublicId ?? null,
    agent_version: run.agentVersion,
    definition: run.definition,
    claim: run.claim ?? null,
    decider_versions: run.deciderVersions ?? null,
    scorer_models: run.scorerModels ?? null,
    status: run.status,
    baseline_run_id: run.baselineRun?.publicId ?? null,
    trigger_id: run.triggerId ?? null,
    aggregate_scores: run.aggregateScores,
    verdict: run.verdict,
    verdict_reasons: run.verdictReasons,
    item_count: run.itemCount,
    completed_count: run.completedCount,
    errored_count: run.erroredCount,
    error: run.error,
    metadata: run.metadata ?? undefined,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    created_at: run.createdAt,
  };
};

export const mapEvalResult = (result: EvalResultRow) => {
  return {
    id: result.publicId,
    eval_run_id: result.evalRun?.publicId,
    dataset_item_id: result.datasetItem?.publicId ?? null,
    input: result.input,
    expected_output: result.expectedOutput,
    generation_id: result.generation?.publicId ?? null,
    output: result.output,
    scores: result.scores,
    passed: result.passed,
    error: result.error,
    human_label:
      result.humanPassed === null
        ? null
        : {
            passed: result.humanPassed,
            note: result.labelNote,
            labeled_by_principal_type: result.labeledByPrincipalType,
            labeled_by_principal_id: result.labeledByPrincipalId,
            labeled_at: result.labeledAt,
          },
    created_at: result.createdAt,
  };
};

export const evalRunIncludes = (): ResourceIncludes => {
  return [
    { model: db.Eval, as: 'eval' },
    { model: db.EvalRun, as: 'baselineRun' },
  ];
};

const evalResultIncludes = (): ResourceIncludes => {
  return [
    { model: db.EvalRun, as: 'evalRun' },
    { model: db.DatasetItem, as: 'datasetItem' },
    { model: db.Generation, as: 'generation' },
  ];
};

const runs = makeResourceAccessor<EvalRunRow>({
  model: () => {
    return db.EvalRun;
  },
  includes: evalRunIncludes,
  label: 'Eval run',
});

/** Re-reads a freshly written run with its associations attached. */
export const reloadEvalRun = async (row: {
  id?: unknown;
}): Promise<EvalRunRow> => {
  return runs.reload(row);
};

/**
 * One run of an eval the caller can read, or `RESOURCE_NOT_FOUND`: scoped by
 * the caller's access to its parent eval, since the run row carries no
 * project column of its own.
 */
export const findEvalRun = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
}): Promise<EvalRunRow> => {
  const evaluation = await getEvalRow({
    projectIds: args.projectIds,
    id: args.evalId,
  });

  const run = (await db.EvalRun.findOne({
    where: { publicId: args.runId, evalId: evaluation.id as number },
    include: evalRunIncludes(),
  })) as EvalRunRow | null;

  if (!run) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Eval run '${args.runId}' not found.`
    );
  }
  return run;
};

/** One result of a run the caller can read, or `RESOURCE_NOT_FOUND`. */
export const findEvalResult = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
  resultId: string;
}): Promise<EvalResultRow> => {
  log('findEvalResult: run=%s result=%s', args.runId, args.resultId);
  const run = await findEvalRun(args);
  const result = (await db.EvalResult.findOne({
    where: { publicId: args.resultId, evalRunId: run.id as number },
    include: evalResultIncludes(),
  })) as EvalResultRow | null;
  if (!result) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Eval result '${args.resultId}' not found.`
    );
  }
  return result;
};

export const listEvalRuns = async (args: {
  projectIds?: number[];
  evalId: string;
  limit?: number;
  cursor?: string;
}): Promise<Page<ReturnType<typeof mapEvalRun>>> => {
  log('listEvalRuns: evalId=%s', args.evalId);

  const evaluation = await getEvalRow({
    projectIds: args.projectIds,
    id: args.evalId,
  });

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      projectIds: args.projectIds,
      evalId: args.evalId,
    },
    where: { evalId: evaluation.id as number },
    order: [['createdAt', 'DESC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.EvalRun.findAll({
        where: pageWhere,
        include: evalRunIncludes(),
        order,
        limit,
      });
    },
    map: (row) => {
      return mapEvalRun(row as EvalRunRow);
    },
  });
};

export const getEvalRun = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
}): Promise<ReturnType<typeof mapEvalRun>> => {
  log('getEvalRun: evalId=%s runId=%s', args.evalId, args.runId);
  return mapEvalRun(await findEvalRun(args));
};

export const listEvalResults = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
  limit?: number;
  cursor?: string;
}): Promise<Page<ReturnType<typeof mapEvalResult>>> => {
  log('listEvalResults: evalId=%s runId=%s', args.evalId, args.runId);

  const run = await findEvalRun({
    projectIds: args.projectIds,
    evalId: args.evalId,
    runId: args.runId,
  });

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      projectIds: args.projectIds,
      evalId: args.evalId,
      runId: args.runId,
    },
    where: { evalRunId: run.id as number },
    order: [['createdAt', 'ASC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.EvalResult.findAll({
        where: pageWhere,
        include: evalResultIncludes(),
        order,
        limit,
      });
    },
    map: (row) => {
      return mapEvalResult(row as EvalResultRow);
    },
  });
};
