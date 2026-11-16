import createDebug from 'debug';

import { db } from '../db';
import { deleteDocument } from './documents';

/**
 * The one way a conversation or a message leaves the database, so every turn
 * document goes with the last message that references it. A caller cannot
 * delete a turn document itself (it sits under the reserved root), and a fork's
 * messages reference its parent's documents, so a document still referenced
 * stays.
 */

const log = createDebug('soat:conversationTurnDocuments');

const RELEASE_BATCH = 50;

const releaseTurnDocuments = async (args: {
  documentIds: number[];
}): Promise<void> => {
  const documentIds = [...new Set(args.documentIds)];
  for (let start = 0; start < documentIds.length; start += RELEASE_BATCH) {
    const batch = documentIds.slice(start, start + RELEASE_BATCH);
    const referenced = await db.ConversationMessage.findAll({
      where: { documentId: batch },
      attributes: ['documentId'],
    });
    const kept = new Set(
      referenced.map((message) => {
        return message.documentId;
      })
    );
    const released = await db.Document.findAll({
      where: {
        id: batch.filter((id) => {
          return !kept.has(id);
        }),
      },
      attributes: ['publicId'],
    });
    for (const document of released) {
      await deleteDocument({ id: document.publicId });
    }
  }
};

/** Deletes a conversation; its messages and its session cascade with it. */
export const destroyConversation = async (args: {
  conversationId: number;
}): Promise<void> => {
  log('destroyConversation: conversationId=%d', args.conversationId);
  const messages = await db.ConversationMessage.findAll({
    where: { conversationId: args.conversationId },
    attributes: ['documentId'],
  });
  await db.Conversation.destroy({ where: { id: args.conversationId } });
  await releaseTurnDocuments({
    documentIds: messages.map((message) => {
      return message.documentId;
    }),
  });
};

export const destroyConversationMessage = async (args: {
  message: InstanceType<(typeof db)['ConversationMessage']>;
}): Promise<void> => {
  log('destroyConversationMessage: documentId=%d', args.message.documentId);
  await args.message.destroy();
  await releaseTurnDocuments({ documentIds: [args.message.documentId] });
};
