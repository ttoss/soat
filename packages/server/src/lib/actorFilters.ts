import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:actors');

export const buildActorListWhere = (args: {
  projectIds?: number[];
  externalId?: string;
  name?: string;
}): Record<string, unknown> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }
  if (args.externalId !== undefined) {
    where.externalId = args.externalId;
  }
  if (args.name !== undefined) {
    where.name = { [Op.iLike]: `%${args.name}%` };
  }
  return where;
};

// Actors that participate in a conversation are derived from its messages
// (there is no direct FK). Returns distinct internal actor ids, or null when
// the conversation does not exist.
const listConversationActorIds = async (args: {
  conversationId: string;
}): Promise<number[] | null> => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });
  if (!conversation) return null;

  const rows = await db.ConversationMessage.findAll({
    where: { conversationId: conversation.id, actorId: { [Op.ne]: null } },
    attributes: ['actorId'],
    group: ['actorId'],
  });

  return rows
    .map((row) => {
      return row.actorId as number | null;
    })
    .filter((id): id is number => {
      return id !== null;
    });
};

/**
 * Resolves the agent/chat/conversation relationship filters into `where`
 * constraints, mutating the supplied object. Each filter resolves a publicId to
 * its internal constraint; an unresolvable filter means "no actors are visible
 * here", so this returns `false` to signal the caller should yield an empty
 * page (never an error). Returns `true` when all provided filters resolved.
 */
export const applyActorRelationshipFilters = async (args: {
  where: Record<string, unknown>;
  agentId?: string;
  chatId?: string;
  conversationId?: string;
}): Promise<boolean> => {
  log('applyActorRelationshipFilters %o', {
    agentId: args.agentId,
    chatId: args.chatId,
    conversationId: args.conversationId,
  });

  if (args.agentId !== undefined) {
    const agent = await db.Agent.findOne({ where: { publicId: args.agentId } });
    if (!agent) return false;
    args.where.agentId = agent.id;
  }

  if (args.chatId !== undefined) {
    const chat = await db.Chat.findOne({ where: { publicId: args.chatId } });
    if (!chat) return false;
    args.where.chatId = chat.id;
  }

  if (args.conversationId !== undefined) {
    const actorIds = await listConversationActorIds({
      conversationId: args.conversationId,
    });
    if (!actorIds || actorIds.length === 0) return false;
    args.where.id = actorIds;
  }

  return true;
};
