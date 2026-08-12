import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:evaluations');

/**
 * Clears the copied output of every eval result linking one of these
 * generations.
 *
 * `EvalResult.output` is a **copy** of the generation's final text on another
 * table, so a content purge that stopped at the generation row would not be a
 * purge at all — the same "erased but still readable" gap the trace cascade
 * exists to close (docs/prd-evaluations.md — Retention & erasure).
 *
 * Only `output` is cleared. Scores, `passed`, and the frozen
 * `input`/`expected_output` are the run's own record rather than the
 * generation's content, so run aggregates stay meaningful after an erasure.
 *
 * Datasets sit deliberately on the other side of this line: they are
 * operator-owned fixtures, and purging a generation never deletes or mutates a
 * dataset item — including one curated from it.
 *
 * Lives in its own module so `contentPurge.ts` can reach it without importing
 * the eval run machinery (and, through it, the generation path it is called
 * from).
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
