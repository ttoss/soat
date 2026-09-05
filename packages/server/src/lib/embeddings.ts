import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { getEmbeddings } from './embedding';

const log = createDebug('soat:embeddings');

/**
 * The project a stateless embedding call is billed to. `null` when the request
 * names none and the credential is bound to none — a plain JWT call belongs to
 * no project, so there is nothing to attribute the usage event to (#1208).
 */
const resolveBillingProjectId = async (args: {
  projectPublicId: string | null;
}): Promise<number | null> => {
  if (!args.projectPublicId) return null;
  const project = await db.Project.findOne({
    where: { publicId: args.projectPublicId },
  });
  return (project?.id as number | undefined) ?? null;
};

export const createEmbeddings = async (args: {
  inputs: string[];
  projectPublicId: string | null;
}): Promise<number[][]> => {
  log(
    'createEmbeddings: count=%d projectId=%s',
    args.inputs.length,
    args.projectPublicId
  );

  if (!process.env.EMBEDDING_PROVIDER || !process.env.EMBEDDING_MODEL) {
    throw new DomainError(
      'EMBEDDING_NOT_CONFIGURED',
      'Embedding service is not configured on this server.'
    );
  }

  const embeddings = await getEmbeddings({
    texts: args.inputs,
    projectId: await resolveBillingProjectId({
      projectPublicId: args.projectPublicId,
    }),
  });

  log('createEmbeddings: done count=%d', embeddings.length);
  return embeddings;
};
