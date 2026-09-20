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

/** Whether a request named the reserved root and so opted into seeing it. */
export const namesSystemPath = (
  paths: Array<string | undefined> | undefined
): boolean => {
  return (paths ?? []).some((path) => {
    return path !== undefined && path.trim() !== '';
  });
};
