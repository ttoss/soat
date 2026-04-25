import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import {
  type CompiledPolicy,
  registerResourceFieldMap,
} from './policyCompiler';

export type { CompiledPolicy };

registerResourceFieldMap({
  resourceType: 'actor',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

const mapActor = (
  actor: InstanceType<(typeof db)['Actor']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']> | null;
    chat?: InstanceType<(typeof db)['Chat']> | null;
  }
) => {
  return {
    id: actor.publicId,
    projectId: actor.project?.publicId,
    name: actor.name,
    type: actor.type ?? undefined,
    externalId: actor.externalId ?? undefined,
    instructions: actor.instructions ?? null,
    agentId: actor.agent?.publicId ?? null,
    chatId: actor.chat?.publicId ?? null,
    tags: actor.tags ?? undefined,
    createdAt: actor.createdAt,
    updatedAt: actor.updatedAt,
  };
};

const actorIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Chat, as: 'chat' },
  ];
};

export const listActors = async (args: {
  projectIds?: number[];
  externalId?: string;
  name?: string;
  type?: string;
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

  if (args.externalId !== undefined) {
    where.externalId = args.externalId;
  }

  if (args.name !== undefined) {
    where.name = { [Op.iLike]: `%${args.name}%` };
  }

  if (args.type !== undefined) {
    where.type = args.type;
  }

  if (args.policyWhere) {
    Object.assign(where, args.policyWhere);
  }

  const { count, rows } = await db.Actor.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: actorIncludes(),
    limit,
    offset,
  });

  return { data: rows.map(mapActor), total: count, limit, offset };
};

export const getActor = async (args: { id: string }) => {
  const actor = await db.Actor.findOne({
    where: { publicId: args.id },
    include: actorIncludes(),
  });

  if (!actor) {
    return null;
  }

  return mapActor(actor);
};

export const createActor = async (args: {
  projectId: number;
  name: string;
  type?: string;
  externalId?: string;
  instructions?: string | null;
  agentId?: number | null;
  chatId?: number | null;
}) => {
  if (args.agentId && args.chatId) {
    return 'agent_and_chat_exclusive' as const;
  }

  const actor = await db.Actor.create({
    projectId: args.projectId,
    name: args.name,
    type: args.type,
    externalId: args.externalId,
    instructions: args.instructions ?? null,
    agentId: args.agentId ?? null,
    chatId: args.chatId ?? null,
  });

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: actorIncludes(),
  });

  return mapActor(actorWithProject!);
};

export const findOrCreateActor = async (args: {
  projectId: number;
  externalId: string;
  name: string;
  type?: string;
  instructions?: string | null;
  agentId?: number | null;
  chatId?: number | null;
}) => {
  if (args.agentId && args.chatId) {
    return 'agent_and_chat_exclusive' as const;
  }

  const [actor, created] = await db.Actor.findOrCreate({
    where: { projectId: args.projectId, externalId: args.externalId },
    defaults: {
      name: args.name,
      type: args.type,
      instructions: args.instructions ?? null,
      agentId: args.agentId ?? null,
      chatId: args.chatId ?? null,
    },
  });

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: actorIncludes(),
  });

  return { actor: mapActor(actorWithProject!), created };
};

export const deleteActor = async (args: { id: string }) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  const messageCount = await db.ConversationMessage.count({
    where: { actorId: actor.id as number },
  });

  if (messageCount > 0) {
    return 'has_messages' as const;
  }

  await actor.destroy();

  return { id: args.id };
};

export const updateActor = async (args: {
  id: string;
  name?: string;
  type?: string;
  externalId?: string;
  instructions?: string | null;
  agentId?: string | null;
  chatId?: string | null;
}) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) {
    updates.name = args.name;
  }
  if (args.type !== undefined) {
    updates.type = args.type;
  }
  if (args.externalId !== undefined) {
    updates.externalId = args.externalId;
  }
  if (args.instructions !== undefined) {
    updates.instructions = args.instructions;
  }

  if (args.agentId !== undefined) {
    if (args.agentId === null) {
      updates.agentId = null;
    } else {
      const agent = await db.Agent.findOne({
        where: { publicId: args.agentId },
      });
      if (!agent) {
        return 'agent_not_found' as const;
      }
      updates.agentId = agent.id;
    }
  }

  if (args.chatId !== undefined) {
    if (args.chatId === null) {
      updates.chatId = null;
    } else {
      const chat = await db.Chat.findOne({
        where: { publicId: args.chatId },
      });
      if (!chat) {
        return 'chat_not_found' as const;
      }
      updates.chatId = chat.id;
    }
  }

  // Enforce mutual exclusivity: if we're setting one, clear the other unless it was also provided.
  const resultingAgent =
    args.agentId !== undefined ? updates.agentId : actor.agentId;
  const resultingChat =
    args.chatId !== undefined ? updates.chatId : actor.chatId;
  if (resultingAgent && resultingChat) {
    return 'agent_and_chat_exclusive' as const;
  }

  await actor.update(updates);

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: actorIncludes(),
  });

  return mapActor(actorWithProject!);
};

export const getActorTags = async (args: { id: string }) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  return actor.tags ?? {};
};

export const updateActorTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    return null;
  }

  const newTags = args.merge
    ? { ...(actor.tags ?? {}), ...args.tags }
    : args.tags;
  await actor.update({ tags: newTags });

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: actorIncludes(),
  });

  return mapActor(actorWithProject!);
};
