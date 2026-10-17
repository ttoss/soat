import { db } from '../db';
import { claimMessageKey } from './conversationMessageIdempotency';
import { insertMessage } from './conversationMessageWrites';
import { conversationEmbedsTurns } from './conversationRetrieval';
import {
  conversationMessageTags,
  ownerActorPublicId,
} from './conversationSystemTags';
import { createDocument, deleteDocument } from './documents';
import { emitResourceEvent } from './eventBus';
import { readFileBuffer } from './fileStorage';
import { makeResourceAccessor } from './resourceAccessor';
import { agentReferences } from './resourceReferences';

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
    metadata: message.metadata ?? undefined,
    idempotency_key: message.idempotencyKey,
  };
};

/**
 * The text of one generated assistant message, addressed by the document id the
 * `conversation_messages.generated` event names.
 *
 * Here rather than in the subscriber because the bytes are behind a file the
 * storage backend owns, and `readStoredFileContent` is that reader — a second
 * copy beside the event dispatcher would be a second thing to keep true.
 */
export const readGeneratedMessageContent = async (args: {
  documentPublicId: string;
}): Promise<string | null> => {
  const message = (await db.ConversationMessage.findOne({
    include: [
      {
        model: db.Document,
        as: 'document',
        required: true,
        where: { publicId: args.documentPublicId },
        include: [{ model: db.File, as: 'file' }],
      },
    ],
  })) as ConversationMessageRow | null;

  return readStoredFileContent(message?.document?.file);
};

/**
 * A message's participants come from the conversation's own project, the same
 * scope its `document_id` is already held to. Unscoped, a message could name an
 * actor or agent from another project — and the listing that filters
 * conversations by `actor_id` would then answer across the boundary.
 */
const resolveParticipantDbIds = async (args: {
  actorId?: string | null;
  agentId?: string | null;
  projectId: number;
}): Promise<{ actorDbId: number | null; agentDbId: number | null } | null> => {
  const [actor, agent] = await Promise.all([
    args.actorId
      ? db.Actor.findOne({
          where: { publicId: args.actorId, projectId: args.projectId },
        })
      : null,
    args.agentId
      ? agentReferences.find({
          id: args.agentId,
          projectId: args.projectId,
          reach: 'shares',
        })
      : null,
  ]);
  if (args.actorId && !actor) return null;
  if (args.agentId && !agent) return null;
  return {
    actorDbId: actor ? actor.id : null,
    agentDbId: agent ? agent.id : null,
  };
};

const replayOf = async (message: ConversationMessageRow) => {
  return { ...(await mapMessage(message)), idempotent: true as const };
};

const emitMessageCreated = (args: {
  conversationId: string;
  projectId: number;
  mapped: Awaited<ReturnType<typeof mapMessage>>;
}) => {
  emitResourceEvent({
    type: 'conversation_messages.created',
    projectId: args.projectId,
    resourceType: 'conversation_message',
    resourceId: args.mapped.document_id,
    data: { ...args.mapped, conversation_id: args.conversationId },
  });
};

type AddConversationMessageArgs = {
  conversationId: string;
  message: string;
  role: string;
  actorId?: string | null;
  agentId?: string | null;
  position?: number;
  metadata?: Record<string, unknown>;
  responseMessages?: unknown[];
  idempotencyKey?: string | null;
  idempotencyDigest?: string | null;
};

type ConversationRow = InstanceType<(typeof db)['Conversation']>;

const createTextMessage = async (
  args: AddConversationMessageArgs & { conversation: ConversationRow }
) => {
  const { conversation } = args;
  const participants = await resolveParticipantDbIds({
    actorId: args.actorId,
    agentId: args.agentId,
    projectId: conversation.projectId,
  });
  if (!participants) return null;
  const { actorDbId, agentDbId } = participants;

  const createdDoc = await createDocument({
    projectId: conversation.projectId,
    content: args.message,
    system: { module: 'conversations', dir: args.conversationId },
    // The turn's author is an actor or agent, recorded in its tags.
    createdBy: null,
    tags: conversationMessageTags({
      conversationPublicId: args.conversationId,
      ownerActorPublicId: ownerActorPublicId(conversation),
      agentPublicId: args.agentId,
      role: args.role,
    }),
    embed: await conversationEmbedsTurns({
      conversationId: conversation.id as number,
      projectId: conversation.projectId,
    }),
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
    idempotencyDigest: args.idempotencyDigest,
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

export const addConversationMessage = async (
  args: AddConversationMessageArgs
) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
    // The owner rides along: every turn is stamped with it, so a per-actor
    // knowledge filter and an IAM condition both have something to name.
    include: [{ model: db.Actor, as: 'actor' }],
  });

  if (!conversation) {
    return null;
  }

  return claimMessageKey({
    conversationId: conversation.id,
    idempotencyKey: args.idempotencyKey,
    idempotencyDigest: args.idempotencyDigest,
    toReplay: replayOf,
    create: () => {
      return createTextMessage({ ...args, conversation });
    },
  });
};

type AddConversationDocumentMessageArgs = {
  conversationId: string;
  documentId: string;
  role: string;
  actorId?: string | null;
  agentId?: string | null;
  position?: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  idempotencyDigest?: string | null;
};

const createDocumentMessage = async (
  args: AddConversationDocumentMessageArgs & { conversation: ConversationRow }
) => {
  const { conversation } = args;
  const participants = await resolveParticipantDbIds({
    actorId: args.actorId,
    agentId: args.agentId,
    projectId: conversation.projectId,
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
    idempotencyKey: args.idempotencyKey ?? null,
    idempotencyDigest: args.idempotencyDigest,
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

export const addConversationDocumentMessage = async (
  args: AddConversationDocumentMessageArgs
) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  return claimMessageKey({
    conversationId: conversation.id,
    idempotencyKey: args.idempotencyKey,
    idempotencyDigest: args.idempotencyDigest,
    toReplay: replayOf,
    create: () => {
      return createDocumentMessage({ ...args, conversation });
    },
  });
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

  const message = (await db.ConversationMessage.findOne({
    where: {
      conversationId: conversation.id,
      documentId: document.id,
    },
    include: conversationMessageIncludes(),
  })) as ConversationMessageRow | null;

  if (!message) {
    return null;
  }

  // Mapped before the delete: the event carries the message as it stood.
  const mapped = await mapMessage(message);

  await message.destroy();

  if (document.publicId) {
    await deleteDocument({ id: document.publicId });
  }

  emitResourceEvent({
    type: 'conversation_messages.deleted',
    projectId: conversation.projectId,
    resourceType: 'conversation_message',
    resourceId: args.documentId,
    data: { ...mapped, conversation_id: args.conversationId },
  });

  return { conversationId: args.conversationId, documentId: args.documentId };
};
