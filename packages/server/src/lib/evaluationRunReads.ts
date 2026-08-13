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
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:evaluations');

export const EVAL_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
] as const;

/** Terminal statuses — the only ones a baseline may be taken from. */
export const TERMINAL_EVAL_RUN_STATUSES: readonly string[] = [
  'completed',
  'failed',
  'canceled',
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
    agent_version: run.agentVersion,
    status: run.status,
    baseline_run_id: run.baselineRun?.publicId ?? null,
    trigger_id: run.triggerId ?? null,
    aggregate_scores: run.aggregateScores,
    passed: run.passed,
    item_count: run.itemCount,
    completed_count: run.completedCount,
    errored_count: run.erroredCount,
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
 * Loads a run, scoped by the caller's access to its **parent Eval** — the run
 * row carries no project column of its own.
 */
const findRun = async (args: {
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

export const listEvalRuns = async (args: {
  projectIds?: number[];
  evalId: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapEvalRun>>> => {
  log('listEvalRuns: evalId=%s', args.evalId);

  const evaluation = await getEvalRow({
    projectIds: args.projectIds,
    id: args.evalId,
  });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.EvalRun.findAndCountAll({
        where: { evalId: evaluation.id as number },
        include: evalRunIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
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
  return mapEvalRun(await findRun(args));
};

export const listEvalResults = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapEvalResult>>> => {
  log('listEvalResults: evalId=%s runId=%s', args.evalId, args.runId);

  const run = await findRun({
    projectIds: args.projectIds,
    evalId: args.evalId,
    runId: args.runId,
  });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.EvalResult.findAndCountAll({
        where: { evalRunId: run.id as number },
        include: evalResultIncludes(),
        order: [['createdAt', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapEvalResult(row as EvalResultRow);
    },
  });
};
