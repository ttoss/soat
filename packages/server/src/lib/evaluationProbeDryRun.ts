/**
 * The probes dry run (the evaluations module doc — Criteria): every probe of
 * the eval as it stands, graded as a run would grade them, and nothing
 * written. Apart from `evaluationProbeRuns.ts`, which the worker imports, so
 * the worker never loads the eval reads this needs.
 */
import createDebug from 'debug';

import { pinDeciderVersions } from './evaluationDeciderScorer';
import { type ProbeReport, runProbes } from './evaluationProbes';
import { buildScorerRunners } from './evaluationRunExecution';
import { getEvalRow } from './evaluations';
import { evalStarts } from './evaluationScorerReferences';
import { scorerList } from './evaluationScorerValidation';
import { assertScorers } from './evaluationWriteChecks';
import { assertProjectAcceptsWork } from './projectPause';
import { resourceWorkAuthority } from './resourceWork';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:evaluations');

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
  // The re-check a run makes, so a stale scorer is named, not a probe error.
  await assertScorers({
    written: undefined,
    stored: evaluation.scorers,
    agentOutputSchema: evaluation.agent?.outputSchema ?? null,
    projectId,
  });
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
    errors: 'record',
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
