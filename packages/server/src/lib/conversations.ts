import { db } from '../db';
import { mapMessage } from './conversationMessages';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import {
  type CompiledPolicy,
  registerResourceFieldMap,
} from './policyCompiler';

export type { CompiledPolicy };

registerResourceFieldMap({
  resourceType: 'conversation',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

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

export const listConversations = async (args: {
  projectIds?: number[];
  actorId?: string;
  policyWhere?: Record<string, unknown>;
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

  if (args.policyWhere) {
    Object.assign(where, args.policyWhere);
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

  const mapped = mapConversation(conversationWithAssociations!);

  emitEvent({
    type: 'conversations.created',
    projectId: conversationWithAssociations!.projectId,
    projectPublicId: mapped.projectId!,
    resourceType: 'conversation',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
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

  const mapped = mapConversation(updated!);

  emitEvent({
    type: 'conversations.updated',
    projectId: updated!.projectId,
    projectPublicId: mapped.projectId!,
    resourceType: 'conversation',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
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

  const mapped = mapConversation(updatedConversation!);

  emitEvent({
    type: 'conversations.updated',
    projectId: updatedConversation!.projectId,
    projectPublicId: mapped.projectId!,
    resourceType: 'conversation',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
};

export const deleteConversation = async (args: { id: string }) => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.id },
  });

  if (!conversation) {
    return null;
  }

  const projectId = conversation.projectId;

  await conversation.destroy();

  resolveProjectPublicId({ projectId }).then((projectPublicId) => {
    emitEvent({
      type: 'conversations.deleted',
      projectId,
      projectPublicId,
      resourceType: 'conversation',
      resourceId: args.id,
      data: { id: args.id },
      timestamp: new Date().toISOString(),
    });
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

  const newTags = args.merge
    ? { ...(conversation.tags ?? {}), ...args.tags }
    : args.tags;
  await conversation.update({ tags: newTags });

  const updated = await db.Conversation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });

  const mapped = mapConversation(updated!);

  emitEvent({
    type: 'conversations.updated',
    projectId: updated!.projectId,
    projectPublicId: mapped.projectId!,
    resourceType: 'conversation',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
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
      { model: db.Agent, as: 'agent' },
    ],
    order: [['position', 'ASC']],
    limit,
    offset,
  });

  return { data: rows.map(mapMessage), total: count, limit, offset };
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
    if (msg.actorId !== null && !seen.has(msg.actorId)) {
      seen.add(msg.actorId);
      if (msg.actor) {
        actors.push(msg.actor);
      }
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
