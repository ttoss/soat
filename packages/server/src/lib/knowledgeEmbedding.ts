import createDebug from 'debug';

import type { EmbeddingBillingProjectId } from './embedding';
import { getEmbedding } from './embedding';

const log = createDebug('soat:knowledge');

/**
 * Embeds a search query, or reports that the provider could not be reached.
 *
 * Before hybrid retrieval an unreachable embedding provider failed the whole
 * search, because the vector query was the only query there was. There is now a
 * second channel that needs nothing from the provider, so the search answers
 * from the lexical one instead — degraded, and visibly so: every result of such
 * a search carries no `similarity_score`, which is the one case the contract
 * leaves that field absent.
 */
export const embedQueryOrDegrade = async (args: {
  text: string;
  projectId: EmbeddingBillingProjectId;
}): Promise<number[] | undefined> => {
  try {
    return await getEmbedding({ text: args.text, projectId: args.projectId });
  } catch (error) {
    log(
      'embedQueryOrDegrade: embedding failed, degrading to lexical-only: %o',
      error
    );
    return undefined;
  }
};

/**
 * The `<column> <=> $query` cosine-distance expression.
 *
 * Both candidate lists select it — the vector query to order by it, the lexical
 * query so a hit only it found still reports its cosine. The vector is
 * interpolated rather than escaped because it is a list of numbers this process
 * just produced; nothing caller-supplied reaches SQL through it.
 */
export const distanceExpression = (args: {
  column: string;
  embedding: number[];
}): string => {
  return `${args.column} <=> '[${args.embedding.join(',')}]'`;
};
