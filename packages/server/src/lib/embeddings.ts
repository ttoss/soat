import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type EmbeddingModelChoice,
  getEmbeddings,
  projectEmbeddingBilling,
} from './embedding';
import { askEmbeddingWrite } from './embeddingAdmission';
import type { RequestPrincipal } from './principals';
import { assertProjectSpendWithinQuota } from './quotaEnforcement';

const log = createDebug('soat:embeddings');

/**
 * The project a stateless embedding call is billed to. `null` when the request
 * names none and the credential is bound to none — a plain JWT call belongs to
 * no project, so there is nothing to attribute the usage event to.
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

/**
 * Embeddings a caller asks for, billed to `projectId` and refused by its
 * `enforce` token/cost quotas before the provider is called.
 */
export const embedForProject = async (args: {
  projectId: number;
  texts: string[];
  pinned?: EmbeddingModelChoice;
  /** Who the embedding acts as; admission is asked unless its request asked. */
  embedAs: RequestPrincipal | null;
}): Promise<number[][]> => {
  await assertProjectSpendWithinQuota({ projectId: args.projectId });
  await askEmbeddingWrite({
    projectId: args.projectId,
    principal: args.embedAs,
    work: 'The embedding call',
  });
  return getEmbeddings({
    texts: args.texts,
    billing: projectEmbeddingBilling({ projectId: args.projectId }),
    subject: null,
    pinned: args.pinned,
  });
};

export const createEmbeddings = async (args: {
  inputs: string[];
  projectPublicId: string | null;
  embedAs: RequestPrincipal | null;
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

  const projectId = await resolveBillingProjectId({
    projectPublicId: args.projectPublicId,
  });
  const embeddings =
    projectId === null
      ? await getEmbeddings({
          texts: args.inputs,
          billing: projectEmbeddingBilling({ projectId: null }),
          subject: null,
        })
      : await embedForProject({
          projectId,
          texts: args.inputs,
          embedAs: args.embedAs,
        });

  log('createEmbeddings: done count=%d', embeddings.length);
  return embeddings;
};
