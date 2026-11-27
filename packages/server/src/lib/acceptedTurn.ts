import createDebug from 'debug';

import type { GenerationIds } from './agentGenerationTypes';
import { loggableError } from './loggableError';

const log = createDebug('soat:accepted-turn');

/**
 * Starts a turn in the background and answers once its generation record
 * exists, so the handle is pollable at once. A refusal before the record
 * (an unknown, closed or busy target) rejects, as it would in the blocking
 * mode; a failure after it is recorded on the generation.
 */
export const acceptTurn = (args: {
  start: (onRecorded: (ids: GenerationIds) => void) => Promise<GenerationIds>;
}): Promise<GenerationIds> => {
  return new Promise((resolve, reject) => {
    let accepted = false;
    args
      .start((ids) => {
        accepted = true;
        resolve(ids);
      })
      .then((settled) => {
        // A turn that settles without a new record (the depth guard) still
        // names the generation it answered with.
        if (!accepted) resolve(settled);
      })
      .catch((error: unknown) => {
        if (!accepted) {
          reject(error);
          return;
        }
        log('acceptTurn: background turn failed %o', loggableError(error));
      });
  });
};
