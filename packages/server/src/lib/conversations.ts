import { db } from '../db';
import { mapMessage } from './conversationMessages';
import {
  conversationEmbedsTurns,
  embedConversationBacklog,
  type RetrievalMode,
} from './conversationRetrieval';
import { deleteDocument } from './documents';
import { emitResourceEvent } from './eventBus';
import { emptyPage, paginatedList } from './pagination';
import {
  type CompiledPolicy,
  registerResourceFieldMap,
} from './policyCompiler';
import { hasPolicyConstraints } from './policyWhere';
import { makeResourceAccessor } from './resourceAccessor';
import { applyTagFilter, mergeTags } from './tags';

export type { CompiledPolicy };

registerResourceFieldMap({
  resourceType: 'conversation',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

type ConversationRow = InstanceType<(typeof db)['Conversation']> & {
  project?: InstanceType<(typeof db)['Project']>;
  actor?: InstanceType<(typeof db)['Actor']> | null;
};

const conversationIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Actor, as: 'actor' },
  ];
};

export const conversations = makeResourceAccessor<ConversationRow>({
  model: () => {
    return db.Conversation;
  },
  includes: conversationIncludes,
  label: 'Conversation',
});

const mapConversation = (conversation: ConversationRow) => {
  return {
    id: conversation.publicId,
    project_id: conversation.project?.publicId,
    actor_id: conversation.actor?.publicId ?? null,
    name: conversation.name ?? null,
    status: conversation.status,
    retrieval: conversation.retrieval ?? null,
    tags: conversation.tags ?? undefined,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
  };
};

export const listConversations = async (args: {
  projectIds?: number[];
  actorId?: string;
  tags?: Record<string, string>;
  policyWhere?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return emptyPage(args);
  }

  const where: Record<string, unknown> = {};

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }
  applyTagFilter({ where, tags: args.tags });

  if (args.actorId !== undefined) {
    const actor = await db.Actor.findOne({ where: { publicId: args.actorId } });
    if (!actor) {
      return emptyPage(args);
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

  if (args.policyWhere) {
    Object.assign(where, args.policyWhere);
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Conversation.findAndCountAll({
        where: hasPolicyConstraints(where) ? where : undefined,
        include: [
          { model: db.Project, as: 'project' },
          { model: db.Actor, as: 'actor' },
        ],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapConversation,
  });
};

export const getConversation = async (args: { id: string }) => {
  const conversation = await conversations.findByPublicId({ id: args.id });

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
  retrieval?: RetrievalMode | null;
}) => {
  const conversation = await db.Conversation.create({
    projectId: args.projectId,
    status: args.status ?? 'open',
    name: args.name ?? null,
    actorId: args.actorId ?? null,
    retrieval: args.retrieval ?? null,
  });

  const conversationWithAssociations = await conversations.reload(conversation);

  const mapped = mapConversation(conversationWithAssociations);

  emitResourceEvent({
    type: 'conversations.created',
    projectId: conversationWithAssociations!.projectId,
    projectPublicId: mapped.project_id!,
    resourceType: 'conversation',
    resourceId: mapped.id,
    data: mapped,
  });

  return mapped;
};

export const updateConversation = async (args: {
  id: string;
  name?: string | null;
  status?: string;
  retrieval?: RetrievalMode | null;
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
  if (args.retrieval !== undefined) {
    updates.retrieval = args.retrieval;
  }

  await conversation.update(updates);

  // Switching retrieval on makes the whole conversation retrievable, not just
  // what is said next — otherwise the turns that prompted the switch stay
  // invisible to the vector channel forever.
  if (
    args.retrieval !== undefined &&
    (await conversationEmbedsTurns({
      conversationId: conversation.id as number,
      projectId: conversation.projectId,
    }))
  ) {
    await embedConversationBacklog({
      conversationId: conversation.id as number,
      projectId: conversation.projectId,
    });
  }

  const updated = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  const mapped = mapConversation(updated!);

  emitResourceEvent({
    type: 'conversations.updated',
    projectId: updated!.projectId,
    projectPublicId: mapped.project_id!,
    resourceType: 'conversation',
    resourceId: mapped.id,
    data: mapped,
  });

  return mapped;
};

// A conversation holds as many turn documents as it has messages, so they are
// walked a page at a time rather than loaded at once.
const TURN_DOCUMENT_BATCH = 50;

/**
 * Deletes the turn documents a conversation's messages own.
 *
 * The message rows cascade off the conversation, but their documents — and the
 * files and chunks behind them — do not, and a caller cannot reach them
 * afterwards: the reserved root they sit under is read-only and the id in their
 * path no longer resolves. Each batch drops its message rows before its
 * documents, because `conversation_messages.document_id` refuses a delete while
 * it still points at one.
 */
const deleteTurnDocuments = async (args: {
  conversationId: number;
}): Promise<void> => {
  for (;;) {
    const messages = await db.ConversationMessage.findAll({
      where: { conversationId: args.conversationId },
      include: [{ model: db.Document, as: 'document' }],
      order: [['id', 'ASC']],
      limit: TURN_DOCUMENT_BATCH,
    });
    if (messages.length === 0) return;

    await db.ConversationMessage.destroy({
      where: {
        id: messages.map((message) => {
          return message.id as number;
        }),
      },
    });

    for (const message of messages) {
      const publicId = message.document?.publicId;
      if (publicId) await deleteDocument({ id: publicId });
    }
  }
};

export const deleteConversation = async (args: { id: string }) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
  });

  if (!conversation) {
    return null;
  }

  const projectId = conversation.projectId;

  await deleteTurnDocuments({ conversationId: conversation.id as number });

  await conversation.destroy();

  emitResourceEvent({
    type: 'conversations.deleted',
    projectId,
    resourceType: 'conversation',
    resourceId: args.id,
    data: { id: args.id },
  });

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

  const newTags = mergeTags({
    current: conversation.tags,
    incoming: args.tags,
    merge: args.merge,
  });
  await conversation.update({ tags: newTags });

  const updated = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  const mapped = mapConversation(updated!);

  emitResourceEvent({
    type: 'conversations.updated',
    projectId: updated!.projectId,
    projectPublicId: mapped.project_id!,
    resourceType: 'conversation',
    resourceId: mapped.id,
    data: mapped,
  });

  // The tag routes' contract is the tag map itself, not the conversation.
  return newTags;
};

export const listConversationMessages = async (args: {
  conversationId: string;
  limit?: number;
  offset?: number;
}) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return null;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.ConversationMessage.findAndCountAll({
        where: { conversationId: conversation.id },
        include: [
          {
            model: db.Document,
            as: 'document',
            include: [{ model: db.File, as: 'file' }],
          },
          { model: db.Actor, as: 'actor' },
          { model: db.Agent, as: 'agent' },
        ],
        order: [['position', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapMessage,
  });
};
