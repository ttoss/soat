import fs from 'node:fs';

import { db } from '../db';
import { createGeneration, type GenerationResult } from './agents';
import { createChatCompletionForChat } from './chats';
import { createDocument, deleteDocument } from './documents';

const mapConversation = (
  conversation: InstanceType<(typeof db)['Conversation']> & {
    project?: InstanceType<(typeof db)['Project']>;
    actor?: InstanceType<(typeof db)['Actor']> | null;
  }
) => {
  return {
    id: conversation.publicId,
    projectId: conversation.project?.publicId,
    actorId: conversation.actor?.publicId ?? null,
    name: conversation.name ?? null,
    status: conversation.status,
    tags: conversation.tags ?? undefined,
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
    metadata: message.metadata ?? null,
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
    const conversationIds = messages.map(
      (m: InstanceType<(typeof db)['ConversationMessage']>) => {
        return m.conversationId;
      }
    );
    where.id = conversationIds;
  }

  const { count, rows } = await db.Conversation.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Actor, as: 'actor' },
    ],
    limit,
    offset,
  });

  return { data: rows.map(mapConversation), total: count, limit, offset };
};

export const getConversation = async (args: { id: string }) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Actor, as: 'actor' },
    ],
  });

  if (!conversation) {
    return null;
  }

  return mapConversation(conversation);
};

export const createConversation = async (args: {
  projectId: number;
  status?: string;
  name?: string | null;
  actorId?: number | null;
}) => {
  const conversation = await db.Conversation.create({
    projectId: args.projectId,
    status: args.status ?? 'open',
    name: args.name ?? null,
    actorId: args.actorId ?? null,
  });

  const conversationWithAssociations = await db.Conversation.findOne({
    where: { id: conversation.id },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Actor, as: 'actor' },
    ],
  });

  return mapConversation(conversationWithAssociations!);
};

export const updateConversation = async (args: {
  id: string;
  name?: string | null;
  status?: string;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
  });

  if (!conversation) {
    return null;
  }

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) {
    updates.name = args.name;
  }
  if (args.status !== undefined) {
    updates.status = args.status;
  }

  await conversation.update(updates);

  const updated = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapConversation(updated!);
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

export const getConversationTags = async (args: { id: string }) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
  });

  if (!conversation) {
    return null;
  }

  return conversation.tags ?? {};
};

export const updateConversationTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
  });

  if (!conversation) {
    return null;
  }

  const newTags = args.merge
    ? { ...(conversation.tags ?? {}), ...args.tags }
    : args.tags;
  await conversation.update({ tags: newTags });

  const updated = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapConversation(updated!);
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
  metadata?: Record<string, unknown>;
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

  const sequelize = db.sequelize;

  const result = await sequelize.transaction(async (t) => {
    let position = args.position;

    if (position === undefined) {
      const maxMessage = await db.ConversationMessage.findOne({
        where: { conversationId: conversation.id },
        order: [['position', 'DESC']],
        transaction: t,
      });
      position = maxMessage ? maxMessage.position + 1 : 0;
    } else {
      // Insert-between: if the position collides, shift existing messages up.
      const collision = await db.ConversationMessage.findOne({
        where: { conversationId: conversation.id, position },
        transaction: t,
      });
      if (collision) {
        // Shift in descending order to avoid unique index violations mid-shift.
        const toShift = await db.ConversationMessage.findAll({
          where: { conversationId: conversation.id },
          order: [['position', 'DESC']],
          transaction: t,
        });
        for (const m of toShift) {
          if (m.position >= position) {
            await m.update({ position: m.position + 1 }, { transaction: t });
          }
        }
      }
    }

    const message = await db.ConversationMessage.create(
      {
        conversationId: conversation.id,
        documentId: document.id,
        actorId: actor.id,
        position,
        metadata: args.metadata ?? null,
      },
      { transaction: t }
    );

    return message;
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

export type GenerateConversationMessageResult =
  | {
      status: 'completed';
      /** AI-generated text of the reply. Always present when status is `completed`. */
      content: string;
      message: ReturnType<typeof mapMessage>;
      generationId: string;
      traceId: string;
      model?: string;
    }
  | {
      status: 'requires_action';
      generationId: string;
      traceId: string;
      requiredAction: NonNullable<GenerationResult['requiredAction']>;
    }
  | 'conversation_not_found'
  | 'actor_not_found'
  | 'actor_missing_agent_or_chat'
  | 'ai_provider_not_found'
  | 'agent_or_chat_not_found';

export const generateConversationMessage = async (args: {
  conversationId: string;
  actorId: string;
  model?: string;
}): Promise<GenerateConversationMessageResult> => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return 'conversation_not_found';
  }

  const generatingActor = await db.Actor.findOne({
    where: { publicId: args.actorId, projectId: conversation.projectId },
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Chat, as: 'chat' },
    ],
  });

  if (!generatingActor) {
    return 'actor_not_found';
  }

  if (!generatingActor.agentId && !generatingActor.chatId) {
    return 'actor_missing_agent_or_chat';
  }

  // Load history ordered by position
  const messages = await db.ConversationMessage.findAll({
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
  });

  // Build chat-style message history
  const history: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    const msg = m as InstanceType<(typeof db)['ConversationMessage']> & {
      document?: InstanceType<(typeof db)['Document']> & {
        file?: InstanceType<(typeof db)['File']>;
      };
      actor?: InstanceType<(typeof db)['Actor']>;
    };

    let content = '';
    if (msg.document?.file?.storagePath) {
      try {
        if (fs.existsSync(msg.document.file.storagePath)) {
          content = fs.readFileSync(msg.document.file.storagePath, 'utf-8');
        }
      } catch {
        // Ignore read errors
      }
    }

    if (msg.actorId === generatingActor.id) {
      history.push({ role: 'assistant', content });
    } else {
      const speakerName = msg.actor?.name ?? 'participant';
      const meta = (msg as { metadata?: Record<string, unknown> | null })
        .metadata;
      const metadataStr =
        meta && Object.keys(meta).length > 0
          ? ` [${Object.entries(meta)
              .map(([k, v]) => {
                return `${k}: ${v}`;
              })
              .join(', ')}]`
          : '';
      history.push({
        role: 'user',
        content: `[${speakerName}]${metadataStr}: ${content}`,
      });
    }
  }

  // Build persona override instructions from the generating actor
  const personaLines: string[] = [];
  if (generatingActor.instructions) {
    personaLines.push(generatingActor.instructions);
  }
  personaLines.push(
    `You are ${generatingActor.name}. Reply as this participant only — do not speak for any other actor.`
  );
  const personaSystem = personaLines.join('\n\n');

  // Prepend the persona as a system message. The underlying agent or chat
  // will combine its own instructions/systemMessage with this one.
  const messagesForModel: Array<{ role: string; content: string }> = [
    { role: 'system', content: personaSystem },
    ...history,
  ];

  let generationId: string;
  let traceId: string;
  let modelName = '';
  let assistantContent = '';
  let requiredAction: GenerationResult['requiredAction'] | undefined;

  if (generatingActor.agentId) {
    const agent = (
      generatingActor as unknown as {
        agent?: InstanceType<(typeof db)['Agent']>;
      }
    ).agent;
    if (!agent) {
      return 'agent_or_chat_not_found';
    }

    const result = await createGeneration({
      agentId: agent.publicId,
      messages: messagesForModel,
    });

    if (result === 'not_found') {
      return 'agent_or_chat_not_found';
    }
    if (result === 'ai_provider_not_found') {
      return 'ai_provider_not_found';
    }
    if (result instanceof ReadableStream) {
      // Should not happen because we did not request streaming
      return 'ai_provider_not_found';
    }

    generationId = result.id;
    traceId = result.traceId;

    if (result.status === 'requires_action') {
      return {
        status: 'requires_action',
        generationId,
        traceId,
        requiredAction: result.requiredAction!,
      };
    }

    assistantContent = result.output?.content ?? '';
    modelName = result.output?.model ?? '';
    requiredAction = undefined;
  } else {
    const chat = (
      generatingActor as unknown as {
        chat?: InstanceType<(typeof db)['Chat']>;
      }
    ).chat;
    if (!chat) {
      return 'agent_or_chat_not_found';
    }

    const result = await createChatCompletionForChat({
      chatId: chat.publicId,
      messages: messagesForModel as Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }>,
      model: args.model,
    });

    if (result === 'chat_not_found') {
      return 'agent_or_chat_not_found';
    }
    if (result === 'ai_provider_not_found') {
      return 'ai_provider_not_found';
    }

    // Chats don't expose generation/trace IDs — synthesize local ones.
    generationId = '';
    traceId = '';
    assistantContent = result.content;
    modelName = result.model;
  }

  // Persist the assistant reply as a new conversation message
  const persisted = await addConversationMessage({
    conversationId: args.conversationId,
    message: assistantContent,
    actorId: args.actorId,
  });

  if (!persisted) {
    return 'conversation_not_found';
  }

  // Suppress unused-variable lint warnings for branches that don't use it
  void requiredAction;

  return {
    status: 'completed',
    content: assistantContent,
    message: persisted,
    generationId,
    traceId,
    model: modelName,
  };
};
