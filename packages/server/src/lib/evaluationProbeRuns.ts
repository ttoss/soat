/**
 * Where probes run (the evaluations module doc — Criteria): before a run's
 * first item, and on the dry-run route. Both grade under the authority a run
 * of the eval holds, with the runners an item is graded with.
 */
import createDebug from 'debug';

import { DomainError } from '../errors';
import { pinDeciderVersions } from './evaluationDeciderScorer';
import { failedProbes, type ProbeReport, runProbes } from './evaluationProbes';
import type { EvalRunDefinition } from './evaluationRunDefinition';
import { buildScorerRunners, failEvalRun } from './evaluationRunExecution';
import { getEvalRow } from './evaluations';
import { evalStarts } from './evaluationScorerReferences';
import { scorerList } from './evaluationScorerValidation';
import { assertProjectAcceptsWork } from './projectPause';
import { resourceWorkAuthority } from './resourceWork';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:evaluations');

type EvalRunRow = Parameters<typeof failEvalRun>[0]['run'];

/**
 * Runs the probes of a run's definition before its first item. A probe that
 * does not hold settles the run `failed` and refuses the start: the scorers
 * do not measure what their criterion says, so no item is worth paying for.
 */
export const assertRunProbesHold = async (args: {
  run: EvalRunRow;
  plan: {
    evaluation: { publicId: string; projectId: unknown };
    agent: { outputSchema: unknown };
    definition: EvalRunDefinition;
    deciderVersions: Record<string, number> | null;
  };
  authority: WorkAuthority | null;
}): Promise<void> => {
  const { plan } = args;
  if (plan.definition.criteria === null) return;
  const projectId = plan.evaluation.projectId as number;
  const report = await runProbes({
    criteria: plan.definition.criteria,
    scorers: plan.definition.scorers,
    agentOutputSchema: plan.agent.outputSchema,
    runners: buildScorerRunners({
      projectId,
      deciderScoring: {
        versions: plan.deciderVersions,
        evalId: plan.evaluation.publicId,
        runId: args.run.publicId,
      },
      datasetItemId: null,
      authority: args.authority,
    }),
  });
  if (report.passed) return;

  const failed = failedProbes(report);
  log(
    'assertRunProbesHold: run=%s failed=%d',
    args.run.publicId,
    failed.length
  );
  await failEvalRun({
    run: args.run,
    projectId,
    reason: `${failed.length} probe(s) did not hold`,
  });
  throw new DomainError(
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
 * Every probe of the eval as it stands, graded without a run: the report a
 * run would start on, and nothing written.
 */
export const dryRunProbes = async (args: {
  projectIds?: number[];
  evalId: string;
  authority: WorkAuthority | null;
}): Promise<ProbeReport> => {
  log('dryRunProbes: evalId=%s', args.evalId);
  const evaluation = await getEvalRow({
    projectIds: args.projectIds,
    id: args.evalId,
  });
  if (!Array.isArray(evaluation.criteria)) return { passed: true, probes: [] };

  const projectId = evaluation.projectId as number;
  await assertProjectAcceptsWork({ projectId });
  const scorers = scorerList(evaluation.scorers);
  const authority = await resourceWorkAuthority({
    carrier: 'evals',
    id: evaluation.publicId,
    projectId,
    startedBy: args.authority,
    starts: evalStarts({
      agentId: evaluation.agent?.publicId as string,
      scorers,
    }),
  });
  return runProbes({
    criteria: evaluation.criteria,
    scorers,
    agentOutputSchema: evaluation.agent?.outputSchema ?? null,
    runners: buildScorerRunners({
      projectId,
      deciderScoring: {
        versions: await pinDeciderVersions({ scorers, projectId }),
        evalId: evaluation.publicId,
        runId: null,
      },
      datasetItemId: null,
      authority,
    }),
  });
};
