import { Op } from '@ttoss/postgresdb';

import { SYSTEM_ROOT } from './filePaths';

/**
 * The reserved root's read default: a collection read leaves out what the
 * runtime wrote unless the request named something inside it.
 *
 * A path filter under the root is what lifts it, so a caller who asks for
 * `/.system/traces/` gets them and one who asks for nothing in particular does
 * not. Reads by id never come through here — a system document stays
 * addressable by the module that owns it.
 */
const SYSTEM_PATH_PATTERN = `${SYSTEM_ROOT}/%`;

/**
 * Matches every row the runtime did not write. A null path is a caller
 * document that was created without one, so it stays in.
 */
export const nonSystemPathWhere = (): Record<symbol, unknown> => {
  return {
    [Op.or]: [{ path: null }, { path: { [Op.notLike]: SYSTEM_PATH_PATTERN } }],
  };
};

/**
 * The status a document holds while its current version is a tombstone.
 *
 * Not a fifth ingestion state but the projection of one, so "is this document
 * live" is an indexed predicate rather than a correlated lookup into
 * `document_versions` on every listing row and every knowledge hit. The
 * version remains the record of the withdrawal; `documentWithdrawal.ts` is the
 * only writer of this value.
 */
export const WITHDRAWN_STATUS = 'withdrawn';

/**
 * Matches every document a reader should see by default: the ones that have
 * not been withdrawn.
 *
 * Beside {@link nonSystemPathWhere} because the two answer the same kind of
 * question — which documents exist for this read — and because a second place
 * deciding it is how a withdrawn document stays reachable from whichever
 * reader was missed. Listing and knowledge search both go through here, and
 * `documentScopeContract.test.ts` fails when a third reader does not.
 *
 * Reads by id never come through here: a withdrawn document stays addressable,
 * which is what makes its history readable and its restore possible.
 */
export const liveDocumentWhere = (): Record<string, unknown> => {
  return { status: { [Op.ne]: WITHDRAWN_STATUS } };
};
