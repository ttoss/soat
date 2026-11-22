import createDebug from 'debug';

import { findEvalResult, mapEvalResult } from './evaluationRunReads';
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
