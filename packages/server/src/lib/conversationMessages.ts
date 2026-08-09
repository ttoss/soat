import { db } from '../db';
import { type Transaction } from './dbTransaction';
import { createDocument, deleteDocument } from './documents';
import { emitResourceEvent } from './eventBus';
import { readFileBuffer } from './fileStorage';
import { makeResourceAccessor } from './resourceAccessor';

const readStoredFileContent = async (
  file?: InstanceType<(typeof db)['File']>
): Promise<string | null> => {
  if (!file?.storagePath) return null;
  const buffer = await readFileBuffer({
    storageType: file.storageType,
    storagePath: file.storagePath,
  });
  return buffer ? buffer.toString('utf-8') : null;
};

type ConversationMessageRow = InstanceType<
  (typeof db)['ConversationMessage']
> & {
  document?: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']>;
  };
  actor?: InstanceType<(typeof db)['Actor']> | null;
  agent?: InstanceType<(typeof db)['Agent']> | null;
};

const conversationMessageIncludes = () => {
  return [
    {
      model: db.Document,
      as: 'document',
      include: [{ model: db.File, as: 'file' }],
    },
    { model: db.Actor, as: 'actor' },
    { model: db.Agent, as: 'agent' },
  ];
};

const conversationMessages = makeResourceAccessor<ConversationMessageRow>({
  model: () => {
    return db.ConversationMessage;
  },
  includes: conversationMessageIncludes,
  label: 'Conversation message',
});

export const mapMessage = async (message: ConversationMessageRow) => {
  return {
    role: message.role,
    document_id: message.document?.publicId,
    actor_id: message.actor?.publicId ?? null,
    agent_id: message.agent?.publicId ?? null,
    position: message.position,
    content: await readStoredFileContent(message.document?.file),
    metadata: message.metadata ?? null,
  };
};

const resolveParticipantDbIds = async (args: {
  actorId?: string | null;
  agentId?: string | null;
}): Promise<{ actorDbId: number | null; agentDbId: number | null } | null> => {
  const [actor, agent] = await Promise.all([
    args.actorId
      ? db.Actor.findOne({ where: { publicId: args.actorId } })
      : null,
    args.agentId
      ? db.Agent.findOne({ where: { publicId: args.agentId } })
      : null,
  ]);
  if (args.actorId && !actor) return null;
  if (args.agentId && !agent) return null;
  return {
    actorDbId: actor ? actor.id : null,
    agentDbId: agent ? agent.id : null,
  };
};

const resolveMessagePosition = async (args: {
  conversationId: number;
  position?: number;
  transaction: Transaction;
}): Promise<number> => {
  if (args.position === undefined) {
    const maxMessage = await db.ConversationMessage.findOne({
      where: { conversationId: args.conversationId },
      order: [['position', 'DESC']],
      transaction: args.transaction,
    });
    return maxMessage ? maxMessage.position + 1 : 0;
  }

  const collision = await db.ConversationMessage.findOne({
    where: { conversationId: args.conversationId, position: args.position },
    transaction: args.transaction,
  });
  if (collision) {
    const toShift = await db.ConversationMessage.findAll({
      where: { conversationId: args.conversationId },
      order: [['position', 'DESC']],
      transaction: args.transaction,
    });
    for (const m of toShift) {
      if (m.position >= args.position) {
        await m.update(
          { position: m.position + 1 },
          { transaction: args.transaction }
        );
      }
    }
  }

  return args.position;
};

const insertMessage = async (args: {
  conversationId: number;
  documentId: number;
  role: string;
  actorId?: number | null;
  agentId?: number | null;
  position?: number;
  metadata?: Record<string, unknown>;
  responseMessages?: unknown[];
  idempotencyKey: string | null;
}) => {
  return db.sequelize.transaction(async (t) => {
    const position = await resolveMessagePosition({
      conversationId: args.conversationId,
      position: args.position,
      transaction: t,
    });

    return db.ConversationMessage.create(
      {
        conversationId: args.conversationId,
        documentId: args.documentId,
        role: args.role,
        actorId: args.actorId ?? null,
        agentId: args.agentId ?? null,
        position,
        metadata: args.metadata ?? null,
        responseMessages: args.responseMessages ?? null,
        idempotencyKey: args.idempotencyKey,
      },
      { transaction: t }
    );
  });
};

const findIdempotentMessage = async (args: {
  conversationId: number;
  idempotencyKey: string;
}) => {
  const existing = await db.ConversationMessage.findOne({
    where: {
      conversationId: args.conversationId,
      idempotencyKey: args.idempotencyKey,
    },
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
  return existing
    ? { ...(await mapMessage(existing)), idempotent: true as const }
    : null;
};

const emitMessageCreated = (args: {
  conversationId: string;
  projectId: number;
  mapped: Awaited<ReturnType<typeof mapMessage>>;
}) => {
  emitResourceEvent({
    type: 'conversations.message.created',
    projectId: args.projectId,
    resourceType: 'conversation_message',
    resourceId: args.mapped.document_id,
    data: {
      ...args.mapped,
      conversationId: args.conversationId,
    },
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
  responseMessages?: unknown[];
  idempotencyKey?: string | null;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  if (args.idempotencyKey) {
    const hit = await findIdempotentMessage({
      conversationId: conversation.id,
      idempotencyKey: args.idempotencyKey,
    });
    if (hit) return hit;
  }

  const participants = await resolveParticipantDbIds({
    actorId: args.actorId,
    agentId: args.agentId,
  });
  if (!participants) return null;
  const { actorDbId, agentDbId } = participants;

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
    responseMessages: args.responseMessages,
    idempotencyKey: args.idempotencyKey ?? null,
  });

  const messageWithAssociations = await conversationMessages.reload(result);

  const mapped = await mapMessage(messageWithAssociations);

  emitMessageCreated({
    conversationId: args.conversationId,
    projectId: conversation.projectId,
    mapped,
  });

  return mapped;
};

export const addConversationDocumentMessage = async (args: {
  conversationId: string;
  documentId: string;
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

  const participants = await resolveParticipantDbIds({
    actorId: args.actorId,
    agentId: args.agentId,
  });

  if (!participants) {
    return null;
  }

  const document = await db.Document.findOne({
    where: { publicId: args.documentId },
    include: [{ model: db.File, as: 'file' }],
  });

  if (!document || document.file?.projectId !== conversation.projectId) {
    return null;
  }

  const result = await insertMessage({
    conversationId: conversation.id,
    documentId: document.id,
    role: args.role,
    actorId: participants.actorDbId,
    agentId: participants.agentDbId,
    position: args.position,
    metadata: args.metadata,
    idempotencyKey: null,
  });

  const messageWithAssociations = await conversationMessages.reload(result);

  const mapped = await mapMessage(messageWithAssociations);

  emitMessageCreated({
    conversationId: args.conversationId,
    projectId: conversation.projectId,
    mapped,
  });

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

  emitResourceEvent({
    type: 'conversations.message.deleted',
    projectId: conversation.projectId,
    resourceType: 'conversation_message',
    resourceId: args.documentId,
    data: {
      conversationId: args.conversationId,
      documentId: args.documentId,
    },
  });

  return { conversationId: args.conversationId, documentId: args.documentId };
};
