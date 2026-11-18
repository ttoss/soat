import createDebug from 'debug';

import { db } from '../db';
import { SYSTEM_FILE_RELEASES } from './systemFileRelease';

/**
 * The one way a conversation or a message leaves the database, so every turn
 * document goes with the last message that references it.
 */

const log = createDebug('soat:conversationTurnDocuments');

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
  await SYSTEM_FILE_RELEASES.conversations({
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
  await SYSTEM_FILE_RELEASES.conversations({
    documentIds: [args.message.documentId],
  });
};
