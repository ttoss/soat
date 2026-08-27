import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:evaluations');

/**
 * Clears the copied output of every eval result linking one of these
 * generations.
 *
 * `EvalResult.output` is a copy of the generation's final text on another
 * table, so a purge that stopped at the generation row would leave content
 * "erased but still readable" (the evaluations module doc — Retention and
 * erasure). Only `output` is cleared: scores and the frozen `input`/
 * `expected_output` are the run's own record, so aggregates stay meaningful.
 * Datasets are operator-owned fixtures and are never touched.
 *
 * Its own module so `contentPurge.ts` can reach it without importing the eval
 * run machinery.
 */
export const redactEvalResultOutputs = async (args: {
  generationDbIds: number[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction?: any;
}): Promise<void> => {
  if (args.generationDbIds.length === 0) return;

  const [redacted] = await db.EvalResult.update(
    { output: null },
    {
      where: { generationId: args.generationDbIds },
      ...(args.transaction ? { transaction: args.transaction } : {}),
    }
  );

  log('redactEvalResultOutputs: results=%d', redacted);
};
