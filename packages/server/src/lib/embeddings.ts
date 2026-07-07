import createDebug from 'debug';

import { DomainError } from '../errors';
import { getEmbeddings } from './embedding';

const log = createDebug('soat:embeddings');

export const createEmbeddings = async (args: {
  inputs: string[];
}): Promise<number[][]> => {
  log('createEmbeddings: count=%d', args.inputs.length);

  if (!process.env.EMBEDDING_PROVIDER || !process.env.EMBEDDING_MODEL) {
    throw new DomainError(
      'EMBEDDING_NOT_CONFIGURED',
      'Embedding service is not configured on this server.'
    );
  }

  const embeddings = await getEmbeddings({ texts: args.inputs });

  log('createEmbeddings: done count=%d', embeddings.length);
  return embeddings;
};
