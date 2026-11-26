import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import {
  calibrationOf,
  type RunCalibration,
  scorerFingerprint,
} from './evaluationCalibration';
import { readEvalRunDefinition } from './evaluationRunDefinition';
import {
  findEvalResult,
  findEvalRun,
  mapEvalResult,
} from './evaluationRunReads';
import { readScorerModels } from './evaluationScorerModels';
import { principalColumns, type RequestPrincipal } from './principals';

const log = createDebug('soat:evaluations');

/**
 * Records a person's verdict on one result, replacing any earlier one. The
 * result's `passed` stays what its scorers said: the label is what a scorer's
 * agreement is measured against, never a correction of it.
 */
export const labelEvalResult = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
  resultId: string;
  passed: boolean;
  note: string | null;
  labeledBy: RequestPrincipal;
}) => {
  log('labelEvalResult: result=%s passed=%s', args.resultId, args.passed);
  const result = await findEvalResult(args);
  await result.update({
    humanPassed: args.passed,
    labelNote: args.note,
    ...principalColumns({ prefix: 'labeledBy', principal: args.labeledBy }),
    labeledAt: new Date(),
  });
  return mapEvalResult(result);
};

/** Clears the label on one result; clearing an unlabeled result is a no-op. */
export const clearEvalResultLabel = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
  resultId: string;
}): Promise<void> => {
  log('clearEvalResultLabel: result=%s', args.resultId);
  const result = await findEvalResult(args);
  await result.update({
    humanPassed: null,
    labelNote: null,
    ...principalColumns({ prefix: 'labeledBy', principal: null }),
    labeledAt: null,
  });
};

/**
 * A run's calibration: each scorer it graded with, against the results people
 * labeled, under the fingerprint of those scorers. A run that recorded no
 * definition has neither scorers nor a fingerprint.
 */
export const getEvalRunCalibration = async (args: {
  projectIds?: number[];
  evalId: string;
  runId: string;
}): Promise<RunCalibration & { scorer_fingerprint: string | null }> => {
  log('getEvalRunCalibration: run=%s', args.runId);
  const run = await findEvalRun(args);
  const definition = readEvalRunDefinition({ run });
  const labeled = await db.EvalResult.findAll({
    where: { evalRunId: run.id as number, humanPassed: { [Op.ne]: null } },
    attributes: ['scores', 'humanPassed'],
  });
  return {
    scorer_fingerprint: definition
      ? scorerFingerprint({
          scorers: definition.scorers,
          deciderVersions: run.deciderVersions,
          scorerModels: readScorerModels(run.scorerModels),
        })
      : null,
    ...calibrationOf({
      scorers: definition?.scorers ?? [],
      labeled: labeled.map((result) => {
        return {
          scores: result.scores,
          humanPassed: result.humanPassed === true,
        };
      }),
    }),
  };
};

/**
 * The calibration of every completed run of one eval against one agent
 * version that was graded by the scorers `fingerprint` names: labels on a
 * run graded otherwise say nothing about these scorers.
 */
export const versionRunCalibrations = async (args: {
  evalDbId: number;
  agentPublicId: string | null;
  version: number;
  fingerprint: string;
}): Promise<RunCalibration[]> => {
  log(
    'versionRunCalibrations: eval=%d version=%d',
    args.evalDbId,
    args.version
  );
  const runs = await db.EvalRun.findAll({
    where: {
      evalId: args.evalDbId,
      agentPublicId: args.agentPublicId,
      agentVersion: args.version,
      status: 'completed',
    },
    attributes: ['id', 'definition', 'deciderVersions', 'scorerModels'],
  });
  const graded = runs.flatMap((run) => {
    const definition = readEvalRunDefinition({ run });
    if (!definition) return [];
    const fingerprint = scorerFingerprint({
      scorers: definition.scorers,
      deciderVersions: run.deciderVersions,
      scorerModels: readScorerModels(run.scorerModels),
    });
    return fingerprint === args.fingerprint
      ? [{ runId: run.id as number, scorers: definition.scorers }]
      : [];
  });
  const labeled = await db.EvalResult.findAll({
    where: {
      evalRunId: graded.map(({ runId }) => {
        return runId;
      }),
      humanPassed: { [Op.ne]: null },
    },
    attributes: ['evalRunId', 'scores', 'humanPassed'],
  });
  return graded.map(({ runId, scorers }) => {
    return calibrationOf({
      scorers,
      labeled: labeled
        .filter((result) => {
          return result.evalRunId === runId;
        })
        .map((result) => {
          return {
            scores: result.scores,
            humanPassed: result.humanPassed === true,
          };
        }),
    });
  });
};
