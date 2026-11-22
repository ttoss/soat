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
import type { RequestPrincipal } from './principals';

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
    labeledByPrincipalType: args.labeledBy.principalType,
    labeledByPrincipalId: args.labeledBy.principalId,
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
    labeledByPrincipalType: null,
    labeledByPrincipalId: null,
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
