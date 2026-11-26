/**
 * Where probes run (the evaluations module doc — Criteria): before a run's
 * first item, and on the dry-run route. Both grade under the authority a run
 * of the eval holds, with the runners an item is graded with.
 */
import createDebug from 'debug';

import { DomainError } from '../errors';
import { failedProbes, type ProbeReport, runProbes } from './evaluationProbes';
import {
  discardEvalItemTasks,
  releaseHeldEvalItemTasks,
} from './evaluationQueue';
import type { EvalRunDefinition } from './evaluationRunDefinition';
import {
  buildScorerRunners,
  claimRunFinalization,
  failEvalRun,
  isLiveRunStatus,
  scoringFailure,
} from './evaluationRunExecution';
import type { ScorerModels } from './evaluationScorerModels';
import {
  INTERNAL_FAILURE,
  type StoredError,
  toStoredError,
} from './storedError';
import { parseWorkAuthority, type WorkAuthority } from './workAuthority';

const log = createDebug('soat:evaluations');

type EvalRunRow = Parameters<typeof failEvalRun>[0]['run'];

/** What a run's probes are graded with: its definition, pins and authority. */
type RunProbeContext = {
  run: EvalRunRow;
  evalPublicId: string;
  projectId: number;
  definition: EvalRunDefinition;
  agentOutputSchema: unknown;
  deciderVersions: Record<string, number> | null;
  scorerModels: ScorerModels | null;
  authority: WorkAuthority | null;
};

/** A run's probes; a scorer that cannot grade one throws its own error. */
const gradeRunProbes = (args: RunProbeContext): Promise<ProbeReport> => {
  return runProbes({
    criteria: args.definition.criteria,
    scorers: args.definition.scorers,
    agentOutputSchema: args.agentOutputSchema,
    errors: 'throw',
    runners: buildScorerRunners({
      projectId: args.projectId,
      deciderScoring: {
        versions: args.deciderVersions,
        evalId: args.evalPublicId,
        runId: args.run.publicId,
      },
      scorerModels: args.scorerModels,
      datasetItemId: null,
      authority: args.authority,
    }),
  });
};

/**
 * Settles the run `failed` unless something settled it first: a cancel that
 * landed while the probes ran keeps its `cancelled`.
 */
const failUnlessSettled = async (args: {
  run: EvalRunRow;
  projectId: number;
  error: StoredError;
}): Promise<void> => {
  await discardEvalItemTasks({ evalRunId: args.run.id as number });
  if (!(await claimRunFinalization({ runDbId: args.run.id as number }))) {
    return;
  }
  await failEvalRun(args);
};

const probeRefusal = (args: {
  run: EvalRunRow;
  report: ProbeReport;
}): DomainError => {
  const failed = failedProbes(args.report);
  return new DomainError(
    'PROBE_FAILED',
    `${failed.length} probe(s) did not hold: ${failed
      .map(({ criterion, index }) => {
        return `${criterion} probe ${index}`;
      })
      .join(', ')}. The run is failed before its first item.`,
    { eval_run_id: args.run.publicId, failed }
  );
};

/**
 * Grades a run's probes and fails the run when one does not hold (`PROBE_FAILED`)
 * or a scorer cannot grade one (the scorer's own error). Returns the refusal,
 * or null when every probe held.
 */
const settleOnProbes = async (args: RunProbeContext): Promise<unknown> => {
  let refusal: unknown = null;
  let error: StoredError | null = null;
  try {
    const report = await gradeRunProbes(args);
    if (!report.passed) {
      const probeFailure = probeRefusal({ run: args.run, report });
      refusal = probeFailure;
      error = toStoredError({
        error: probeFailure,
        opaque: INTERNAL_FAILURE,
        label: 'settleOnProbes',
      });
    }
  } catch (scorerError) {
    refusal = scorerError;
    error = scoringFailure(scorerError);
  }
  if (error === null) return null;
  log('settleOnProbes: run=%s refused', args.run.publicId);
  await failUnlessSettled({ run: args.run, projectId: args.projectId, error });
  return refusal;
};

/**
 * A synchronous run's probes, before its first item. A refusal fails the run
 * and is thrown to the caller; once they hold, the run goes on only if
 * nothing (a cancel) settled it while they ran.
 */
export const assertRunProbesHold = async (args: {
  run: EvalRunRow;
  plan: {
    evaluation: { publicId: string; projectId: unknown };
    agent: { outputSchema: unknown };
    definition: EvalRunDefinition;
    deciderVersions: Record<string, number> | null;
    scorerModels: ScorerModels | null;
  };
  authority: WorkAuthority | null;
}): Promise<boolean> => {
  const { plan, run } = args;
  if (plan.definition.criteria === null) return true;
  const refusal = await settleOnProbes({
    run,
    evalPublicId: plan.evaluation.publicId,
    projectId: plan.evaluation.projectId as number,
    definition: plan.definition,
    agentOutputSchema: plan.agent.outputSchema,
    deciderVersions: plan.deciderVersions,
    scorerModels: plan.scorerModels,
    authority: args.authority,
  });
  if (refusal !== null) throw refusal;
  await run.reload();
  return isLiveRunStatus(run.status);
};

/**
 * A queued run's probes, graded by the worker on its first task while the
 * other items are held: `startedAt` stays unset until they hold, so a
 * redelivered first task grades them again rather than skipping them. Returns
 * whether the task's item may run.
 */
export const openRunProbeGate = async (
  args: Omit<RunProbeContext, 'authority'>
): Promise<boolean> => {
  const { run } = args;
  if (args.definition.criteria === null || run.startedAt !== null) {
    return true;
  }
  const refusal = await settleOnProbes({
    ...args,
    authority: parseWorkAuthority(run.authority),
  });
  if (refusal !== null) return false;
  // A cancel that landed while the probes ran settled the run: no item runs.
  await run.reload();
  if (!isLiveRunStatus(run.status)) return false;
  await releaseHeldEvalItemTasks({ evalRunId: run.id as number });
  await run.update({ startedAt: new Date() });
  return true;
};
