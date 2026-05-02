import fs from 'node:fs';

import { db } from '../db';
import { createDocument, deleteDocument } from './documents';
import { emitEvent, resolveProjectPublicId } from './eventBus';

export const mapMessage = (
  message: InstanceType<(typeof db)['ConversationMessage']> & {
    document?: InstanceType<(typeof db)['Document']> & {
      file?: InstanceType<(typeof db)['File']>;
    };
    actor?: InstanceType<(typeof db)['Actor']> | null;
    agent?: InstanceType<(typeof db)['Agent']> | null;
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
    role: message.role,
    documentId: message.document?.publicId,
    actorId: message.actor?.publicId ?? null,
    agentId: message.agent?.publicId ?? null,
    position: message.position,
    content,
    metadata: message.metadata ?? null,
  };
};

const insertMessage = async (args: {
  conversationId: number;
  documentId: number;
  role: string;
  actorId?: number | null;
  agentId?: number | null;
  position?: number;
  metadata?: Record<string, unknown>;
}) => {
  return db.sequelize.transaction(async (t) => {
    let position = args.position;

    if (position === undefined) {
      const maxMessage = await db.ConversationMessage.findOne({
        where: { conversationId: args.conversationId },
        order: [['position', 'DESC']],
        transaction: t,
      });
      position = maxMessage ? maxMessage.position + 1 : 0;
    } else {
      const collision = await db.ConversationMessage.findOne({
        where: { conversationId: args.conversationId, position },
        transaction: t,
      });
      if (collision) {
        const toShift = await db.ConversationMessage.findAll({
          where: { conversationId: args.conversationId },
          order: [['position', 'DESC']],
          transaction: t,
        });
        for (const m of toShift) {
          if (m.position >= (args.position ?? 0)) {
            await m.update({ position: m.position + 1 }, { transaction: t });
          }
        }
      }
    }

    return db.ConversationMessage.create(
      {
        conversationId: args.conversationId,
        documentId: args.documentId,
        role: args.role,
        actorId: args.actorId ?? null,
        agentId: args.agentId ?? null,
        position,
        metadata: args.metadata ?? null,
      },
      { transaction: t }
    );
  });
};

export const addConversationMessage = async (args: {
  conversationId: string;
  message: string;
  role: string;
  actorId?: string | null;
  agentId?: string | null;
  position?: number;
  metadata?: Record<string, unknown>;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  let actorDbId: number | null = null;
  if (args.actorId) {
    const actor = await db.Actor.findOne({ where: { publicId: args.actorId } });
    if (!actor) {
      return null;
    }
    actorDbId = actor.id;
  }

  let agentDbId: number | null = null;
  if (args.agentId) {
    const agent = await db.Agent.findOne({ where: { publicId: args.agentId } });
    if (!agent) {
      return null;
    }
    agentDbId = agent.id;
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

  const result = await insertMessage({
    conversationId: conversation.id,
    documentId: document.id,
    role: args.role,
    actorId: actorDbId,
    agentId: agentDbId,
    position: args.position,
    metadata: args.metadata,
  });

  const messageWithAssociations = await db.ConversationMessage.findOne({
    where: { id: result.id },
    include: [
      {
        model: db.Document,
        as: 'document',
        include: [{ model: db.File, as: 'file' }],
      },
      { model: db.Actor, as: 'actor' },
      { model: db.Agent, as: 'agent' },
    ],
  });

  const mapped = mapMessage(messageWithAssociations!);

  resolveProjectPublicId({ projectId: conversation.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'conversations.message.created',
        projectId: conversation.projectId,
        projectPublicId,
        resourceType: 'conversation_message',
        resourceId: mapped.documentId,
        data: {
          ...mapped,
          conversationId: args.conversationId,
        } as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return mapped;
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

  if (document.publicId) {
    await deleteDocument({ id: document.publicId });
  }

  resolveProjectPublicId({ projectId: conversation.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'conversations.message.deleted',
        projectId: conversation.projectId,
        projectPublicId,
        resourceType: 'conversation_message',
        resourceId: args.documentId,
        data: {
          conversationId: args.conversationId,
          documentId: args.documentId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );

  return { conversationId: args.conversationId, documentId: args.documentId };
};
