import createDebug from 'debug';

import { DomainError } from '../errors';
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
 *
 * A misconfiguration is not that case. `EMBEDDING_NOT_CONFIGURED` is raised
 * before any request leaves the process, and degrading on it would answer `200`
 * with an empty list indefinitely: the default `simple` text-search
 * configuration ANDs every term, so a natural-language query matches nothing
 * lexically, and a server missing `EMBEDDING_PROVIDER` would read as a corpus
 * with no relevant rows — silently, including through agent knowledge
 * injection. Only a failure the provider could recover from degrades; a
 * `DomainError` is deliberate and reaches the caller as the status it names.
 */
export const embedQueryOrDegrade = async (args: {
  text: string;
  projectId: EmbeddingBillingProjectId;
}): Promise<number[] | undefined> => {
  try {
    return await getEmbedding({ text: args.text, projectId: args.projectId });
  } catch (error) {
    if (error instanceof DomainError) throw error;
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
