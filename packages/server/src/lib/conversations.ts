import fs from 'node:fs';

import { db } from '../db';
import { createDocument, deleteDocument } from './documents';

const mapConversation = (
  conversation: InstanceType<(typeof db)['Conversation']> & {
    project?: InstanceType<(typeof db)['Project']>;
  }
) => {
  return {
    id: conversation.publicId,
    projectId: conversation.project?.publicId,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
};

const mapMessage = (
  message: InstanceType<(typeof db)['ConversationMessage']> & {
    document?: InstanceType<(typeof db)['Document']> & {
      file?: InstanceType<(typeof db)['File']>;
    };
    actor?: InstanceType<(typeof db)['Actor']>;
  }
) => {
  let content: string | null = null;
  if (message.document?.file?.storagePath) {
    try {
      if (fs.existsSync(message.document.file.storagePath)) {
        content = fs.readFileSync(message.document.file.storagePath, 'utf-8');
      }
    } catch {
      // Ignore read errors
    }
  }

  return {
    documentId: message.document?.publicId,
    actorId: message.actor?.publicId,
    position: message.position,
    content,
  };
};

export const listConversations = async (args: {
  projectIds?: number[];
  actorId?: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return { data: [], total: 0, limit, offset };
  }

  const where: Record<string, unknown> = {};

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  if (args.actorId !== undefined) {
    const actor = await db.Actor.findOne({ where: { publicId: args.actorId } });
    if (!actor) {
      return { data: [], total: 0, limit, offset };
    }
    const messages = await db.ConversationMessage.findAll({
      where: { actorId: actor.id },
      attributes: ['conversationId'],
      group: ['conversationId'],
    });
    const conversationIds = messages.map((m) => {
      return m.conversationId;
    });
    where.id = conversationIds;
  }

  const { count, rows } = await db.Conversation.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [{ model: db.Project, as: 'project' }],
    limit,
    offset,
  });

  return { data: rows.map(mapConversation), total: count, limit, offset };
};

export const getConversation = async (args: { id: string }) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!conversation) {
    return null;
  }

  return mapConversation(conversation);
};

export const createConversation = async (args: {
  projectId: number;
  status?: string;
}) => {
  const conversation = await db.Conversation.create({
    projectId: args.projectId,
    status: args.status ?? 'open',
  });

  const conversationWithAssociations = await db.Conversation.findOne({
    where: { id: conversation.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapConversation(conversationWithAssociations!);
};

export const updateConversationStatus = async (args: {
  id: string;
  status: string;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
  });

  if (!conversation) {
    return null;
  }

  await conversation.update({ status: args.status });

  const updatedConversation = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapConversation(updatedConversation!);
};

export const deleteConversation = async (args: { id: string }) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
  });

  if (!conversation) {
    return null;
  }

  await conversation.destroy();

  return { id: args.id };
};

export const listConversationMessages = async (args: {
  conversationId: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  const { count, rows } = await db.ConversationMessage.findAndCountAll({
    where: { conversationId: conversation.id },
    include: [
      {
        model: db.Document,
        as: 'document',
        include: [{ model: db.File, as: 'file' }],
      },
      { model: db.Actor, as: 'actor' },
    ],
    order: [['position', 'ASC']],
    limit,
    offset,
  });

  return { data: rows.map(mapMessage), total: count, limit, offset };
};

export const addConversationMessage = async (args: {
  conversationId: string;
  message: string;
  actorId: string;
  position?: number;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  const actor = await db.Actor.findOne({ where: { publicId: args.actorId } });

  if (!actor) {
    return null;
  }

  const createdDoc = await createDocument({
    projectId: conversation.projectId,
    content: args.message,
  });

  const document = await db.Document.findOne({
    where: { publicId: createdDoc.id },
  });

  if (!document) {
    return null;
  }

  let position = args.position;

  if (position === undefined) {
    const maxMessage = await db.ConversationMessage.findOne({
      where: { conversationId: conversation.id },
      order: [['position', 'DESC']],
    });
    position = maxMessage ? maxMessage.position + 1 : 0;
  }

  const message = await db.ConversationMessage.create({
    conversationId: conversation.id,
    documentId: document.id,
    actorId: actor.id,
    position,
  });

  const messageWithAssociations = await db.ConversationMessage.findOne({
    where: { id: message.id },
    include: [
      {
        model: db.Document,
        as: 'document',
        include: [{ model: db.File, as: 'file' }],
      },
      { model: db.Actor, as: 'actor' },
    ],
  });

  return mapMessage(messageWithAssociations!);
};

export const removeConversationMessage = async (args: {
  conversationId: string;
  documentId: string;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  const document = await db.Document.findOne({
    where: { publicId: args.documentId },
  });

  if (!document) {
    return null;
  }

  const message = await db.ConversationMessage.findOne({
    where: {
      conversationId: conversation.id,
      documentId: document.id,
    },
  });

  if (!message) {
    return null;
  }

  await message.destroy();

  // Also delete the associated document to avoid orphans (Bug #3)
  if (document.publicId) {
    await deleteDocument({ id: document.publicId });
  }

  return { conversationId: args.conversationId, documentId: args.documentId };
};

export const listConversationActors = async (args: {
  conversationId: string;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  const messages = await db.ConversationMessage.findAll({
    where: { conversationId: conversation.id },
    include: [
      {
        model: db.Actor,
        as: 'actor',
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
  });

  const seen = new Set<number>();
  const actors = [];
  for (const msg of messages) {
    if (!seen.has(msg.actorId)) {
      seen.add(msg.actorId);
      actors.push(msg.actor);
    }
  }

  return actors.map((actor) => {
    return {
      id: actor.publicId,
      projectId: actor.project?.publicId,
      name: actor.name,
      type: actor.type ?? undefined,
      externalId: actor.externalId ?? undefined,
      createdAt: actor.createdAt,
      updatedAt: actor.updatedAt,
    };
  });
};
