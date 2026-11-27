import { db } from '../db';
import { assertWorkAdmitted, isAdmissionDeclared } from './admission';
import { principalOfAuthority, type RequestPrincipal } from './principals';
import { parseWorkAuthority, workAuthorityMissing } from './workAuthority';

export const EMBEDDING_WRITE_ACTION = 'embeddings:CreateEmbeddings';

declare const asked: unique symbol;

/**
 * Proof that admission was asked about an embedding write. Only this module
 * mints one, and `getEmbeddings` takes a stored subject only with it.
 */
export type EmbeddingWriteAsk = { readonly [asked]: true; projectId: number };

const mint = (projectId: number): EmbeddingWriteAsk => {
  return { projectId } as EmbeddingWriteAsk;
};

/**
 * Asks admission once about a write that embeds what it stores, before
 * anything is written or embedded. A write holding no principal is refused
 * while the action is declared.
 */
export const askEmbeddingWrite = async (args: {
  projectId: number;
  principal: RequestPrincipal | null;
  /** The write, as a refusal for a missing principal names it. */
  work: string;
}): Promise<EmbeddingWriteAsk> => {
  if (!isAdmissionDeclared(EMBEDDING_WRITE_ACTION)) {
    return mint(args.projectId);
  }
  if (!args.principal) throw workAuthorityMissing({ work: args.work });
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
  });
  await assertWorkAdmitted({
    action: EMBEDDING_WRITE_ACTION,
    projectPublicId: (project?.publicId as string | undefined) ?? null,
    resourceType: null,
    targetId: null,
    principal: args.principal,
  });
  return mint(args.projectId);
};

/**
 * A converter's callback finishes an ingest whose write was asked when it was
 * enqueued; the claimed attempt is that ingest.
 */
export const askOfClaimedConversion = (args: {
  projectId: number;
  claimed: true;
}): EmbeddingWriteAsk => {
  return mint(args.projectId);
};

/** The principal a generation's work acts as, or null when it stored none. */
export const generationPrincipal = async (args: {
  generationId: string | null | undefined;
}): Promise<RequestPrincipal | null> => {
  if (!args.generationId) return null;
  const generation = await db.Generation.findOne({
    where: { publicId: args.generationId },
    attributes: ['authority'],
  });
  return principalOfAuthority(parseWorkAuthority(generation?.authority));
};
