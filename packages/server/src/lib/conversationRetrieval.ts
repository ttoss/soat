import createDebug from 'debug';

import { db } from '../db';
import { getEmbedding, projectEmbeddingBilling } from './embedding';
import type { EmbeddingWriteAsk } from './embeddingAdmission';

const log = createDebug('soat:conversations');

/**
 * Whether a conversation's turns are embedded for vector retrieval.
 *
 * Turns are stored and chunked either way, so `none` costs a conversation
 * nothing but its place in the vector channel: it stays readable by id, in the
 * message list, and through lexical search.
 */
export const RETRIEVAL_MODES = ['embed', 'none'] as const;

export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/** `null` on the conversation inherits the project's default. */
export const resolveRetrievalMode = (args: {
  conversation: 'embed' | 'none' | null;
  project: 'embed' | 'none' | undefined;
}): RetrievalMode => {
  return args.conversation ?? args.project ?? 'none';
};

/**
 * The mode in force for a conversation, read fresh on every turn so a change
 * takes effect from the next message rather than from the next process.
 */
export const conversationEmbedsTurns = async (args: {
  conversationId: number;
  projectId: number;
}): Promise<boolean> => {
  const [conversation, project] = await Promise.all([
    db.Conversation.findByPk(args.conversationId),
    db.Project.findByPk(args.projectId),
  ]);
  return (
    resolveRetrievalMode({
      conversation: conversation?.retrieval ?? null,
      project: project?.defaultConversationRetrieval,
    }) === 'embed'
  );
};

/** Whether setting a conversation's `retrieval` to `retrieval` embeds its turns. */
export const retrievalEmbeds = async (args: {
  projectId: number;
  retrieval: RetrievalMode | null;
}): Promise<boolean> => {
  const project = await db.Project.findByPk(args.projectId);
  return (
    resolveRetrievalMode({
      conversation: args.retrieval,
      project: project?.defaultConversationRetrieval,
    }) === 'embed'
  );
};

/**
 * Embeds the turns a conversation accumulated while it was not embedding them,
 * so switching it on makes the whole conversation retrievable rather than only
 * what is said next — the same shape as re-ingesting a document.
 *
 * Only chunks still missing a vector are touched, which makes a repeat call a
 * no-op and a partial failure resumable.
 */
export const embedConversationBacklog = async (args: {
  conversationId: number;
  projectId: number;
  /** Asked before the retrieval change that starts the backlog was stored. */
  ask: EmbeddingWriteAsk;
}): Promise<number> => {
  const messages = await db.ConversationMessage.findAll({
    where: { conversationId: args.conversationId },
    attributes: ['documentId'],
  });
  const chunks = await db.DocumentChunk.findAll({
    where: {
      documentId: messages.map((message) => {
        return message.documentId;
      }),
      embedding: null,
    },
  });

  let embedded = 0;
  for (const chunk of chunks) {
    try {
      const embedding = await getEmbedding({
        text: chunk.content,
        billing: projectEmbeddingBilling({ projectId: args.projectId }),
        subject: { documentId: chunk.documentId },
        ask: args.ask,
      });
      await chunk.update({ embedding });
      embedded += 1;
    } catch {
      // One unembeddable chunk must not strand the rest; the next call retries
      // it, because it is still the set of chunks without a vector.
    }
  }

  log(
    'embedConversationBacklog: conversationId=%d embedded=%d',
    args.conversationId,
    embedded
  );
  return embedded;
};
