import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type CompiledPolicy,
  registerResourceFieldMap,
} from './policyCompiler';

const log = createDebug('soat:actors');

export type { CompiledPolicy };

registerResourceFieldMap({
  resourceType: 'actor',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

const getLinkedPublicId = (
  linked: { publicId?: string } | null | undefined
): string | null => {
  return linked?.publicId ?? null;
};

const mapActor = (
  actor: InstanceType<(typeof db)['Actor']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']> | null;
    chat?: InstanceType<(typeof db)['Chat']> | null;
    memory?: InstanceType<(typeof db)['Memory']> | null;
  }
) => {
  return {
    id: actor.publicId,
    projectId: actor.project?.publicId,
    name: actor.name,
    externalId: actor.externalId ?? undefined,
    instructions: actor.instructions ?? null,
    agentId: getLinkedPublicId(actor.agent),
    chatId: getLinkedPublicId(actor.chat),
    memoryId: getLinkedPublicId(actor.memory),
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
    { model: db.Memory, as: 'memory' },
  ];
};

const buildActorListWhere = (args: {
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

export const validateActorExclusivity = (args: {
  agentId: unknown;
  chatId: unknown;
}): string | null => {
  if (args.agentId && args.chatId) {
    return 'agentId and chatId are mutually exclusive';
  }
  return null;
};

export const resolveActorLinkedIds = async (args: {
  agentId?: string | null;
  chatId?: string | null;
  memoryId?: string | null;
  projectId?: number;
}): Promise<{
  agentId?: number | null;
  chatId?: number | null;
  memoryId?: number | null;
}> => {
  log(
    'resolveActorLinkedIds: agentId=%s chatId=%s memoryId=%s projectId=%s',
    args.agentId,
    args.chatId,
    args.memoryId,
    args.projectId
  );

  const result: {
    agentId?: number | null;
    chatId?: number | null;
    memoryId?: number | null;
  } = {};

  if (args.agentId !== undefined) {
    if (args.agentId === null) {
      result.agentId = null;
    } else {
      const where: Record<string, unknown> = { publicId: args.agentId };
      if (args.projectId !== undefined) where.projectId = args.projectId;
      const agent = await db.Agent.findOne({ where });
      if (!agent)
        throw new DomainError(
          'AGENT_NOT_FOUND',
          `Agent '${args.agentId}' not found.`
        );
      result.agentId = agent.id as number;
    }
  }

  if (args.chatId !== undefined) {
    if (args.chatId === null) {
      result.chatId = null;
    } else {
      const where: Record<string, unknown> = { publicId: args.chatId };
      if (args.projectId !== undefined) where.projectId = args.projectId;
      const chat = await db.Chat.findOne({ where });
      if (!chat)
        throw new DomainError(
          'CHAT_NOT_FOUND',
          `Chat '${args.chatId}' not found.`
        );
      result.chatId = chat.id as number;
    }
  }

  if (args.memoryId !== undefined) {
    if (args.memoryId === null) {
      result.memoryId = null;
    } else {
      const where: Record<string, unknown> = { publicId: args.memoryId };
      if (args.projectId !== undefined) where.projectId = args.projectId;
      const memory = await db.Memory.findOne({ where });
      if (!memory)
        throw new DomainError(
          'MEMORY_NOT_FOUND',
          `Memory '${args.memoryId}' not found.`
        );
      result.memoryId = memory.id as number;
    }
  }

  return result;
};

const buildActorUpdates = (args: {
  name?: string;
  externalId?: string;
  instructions?: string | null;
}): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) {
    updates.name = args.name;
  }
  if (args.externalId !== undefined) {
    updates.externalId = args.externalId;
  }
  if (args.instructions !== undefined) {
    updates.instructions = args.instructions;
  }
  return updates;
};

export const listActors = async (args: {
  projectIds?: number[];
  externalId?: string;
  name?: string;
  policyWhere?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return { data: [], total: 0, limit, offset };
  }

  const where = buildActorListWhere({
    projectIds: args.projectIds,
    externalId: args.externalId,
    name: args.name,
  });

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
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Actor '${args.id}' not found.`
    );
  }

  return mapActor(actor);
};

export const createActor = async (args: {
  projectId: number;
  name: string;
  externalId?: string;
  instructions?: string | null;
  agentId?: number | null;
  chatId?: number | null;
  memoryId?: number | null;
  autoCreateMemory?: boolean;
}) => {
  log(
    'createActor: projectId=%d name=%s externalId=%s autoCreateMemory=%s',
    args.projectId,
    args.name,
    args.externalId,
    args.autoCreateMemory
  );

  if (args.agentId && args.chatId) {
    throw new DomainError(
      'AGENT_AND_CHAT_EXCLUSIVE',
      'An actor cannot have both an agent_id and a chat_id.'
    );
  }

  let resolvedMemoryId = args.memoryId ?? null;
  if (args.autoCreateMemory && resolvedMemoryId === null) {
    log('createActor: auto-creating memory for actor name=%s', args.name);
    const { createMemory } = await import('./memories');
    const memory = await createMemory({
      projectId: args.projectId,
      name: args.name,
    });
    log('createActor: auto-created memory id=%s', memory.id);
    const memoryRow = await db.Memory.findOne({
      where: { publicId: memory.id },
    });
    resolvedMemoryId = memoryRow ? (memoryRow.id as number) : null;
  }

  const actor = await db.Actor.create({
    projectId: args.projectId,
    name: args.name,
    externalId: args.externalId,
    instructions: args.instructions ?? null,
    agentId: args.agentId ?? null,
    chatId: args.chatId ?? null,
    memoryId: resolvedMemoryId,
  });

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: actorIncludes(),
  });

  log('createActor: created actor id=%s', actorWithProject!.publicId);
  return mapActor(actorWithProject!);
};

const attachMemoryToActor = async (args: {
  actor: InstanceType<(typeof db)['Actor']>;
  projectId: number;
  name: string;
}) => {
  log('attachMemoryToActor: auto-creating memory name=%s', args.name);
  const { createMemory } = await import('./memories');
  const memory = await createMemory({
    projectId: args.projectId,
    name: args.name,
  });
  log('attachMemoryToActor: created memory id=%s', memory.id);
  const memoryRow = await db.Memory.findOne({ where: { publicId: memory.id } });
  if (memoryRow) {
    await args.actor.update({ memoryId: memoryRow.id as number });
  }
};

export const findOrCreateActor = async (args: {
  projectId: number;
  externalId: string;
  name: string;
  instructions?: string | null;
  agentId?: number | null;
  chatId?: number | null;
  memoryId?: number | null;
  autoCreateMemory?: boolean;
}) => {
  log(
    'findOrCreateActor: projectId=%d externalId=%s name=%s autoCreateMemory=%s',
    args.projectId,
    args.externalId,
    args.name,
    args.autoCreateMemory
  );

  if (args.agentId && args.chatId) {
    throw new DomainError(
      'AGENT_AND_CHAT_EXCLUSIVE',
      'An actor cannot have both an agent_id and a chat_id.'
    );
  }

  const [actor, created] = await db.Actor.findOrCreate({
    where: { projectId: args.projectId, externalId: args.externalId },
    defaults: {
      name: args.name,
      instructions: args.instructions ?? null,
      agentId: args.agentId ?? null,
      chatId: args.chatId ?? null,
      memoryId: args.memoryId ?? null,
    },
  });

  log('findOrCreateActor: actor=%s created=%s', actor.publicId, created);

  if (created && args.autoCreateMemory && !args.memoryId) {
    await attachMemoryToActor({
      actor,
      projectId: args.projectId,
      name: args.name,
    });
  }

  const actorWithProject = await db.Actor.findOne({
    where: { id: actor.id },
    include: actorIncludes(),
  });

  return { actor: mapActor(actorWithProject!), created };
};

export const deleteActor = async (args: { id: string }) => {
  log('deleteActor: id=%s', args.id);

  const actor = await db.Actor.findOne({ where: { publicId: args.id } });

  if (!actor) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Actor '${args.id}' not found.`
    );
  }

  const messageCount = await db.ConversationMessage.count({
    where: { actorId: actor.id as number },
  });

  if (messageCount > 0) {
    throw new DomainError(
      'ACTOR_HAS_MESSAGES',
      `Actor '${args.id}' has linked session messages and cannot be deleted.`
    );
  }

  await actor.destroy();
};

export const updateActor = async (args: {
  id: string;
  name?: string;
  externalId?: string;
  instructions?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  memoryId?: string | null;
}) => {
  log(
    'updateActor: id=%s name=%s externalId=%s memoryId=%s',
    args.id,
    args.name,
    args.externalId,
    args.memoryId
  );

  const actor = await db.Actor.findOne({ where: { publicId: args.id } });
  if (!actor) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Actor '${args.id}' not found.`
    );
  }

  const updates = buildActorUpdates({
    name: args.name,
    externalId: args.externalId,
    instructions: args.instructions,
  });

  const resolved = await resolveActorLinkedIds({
    agentId: args.agentId,
    chatId: args.chatId,
    memoryId: args.memoryId,
  });

  if (resolved.agentId !== undefined) updates.agentId = resolved.agentId;
  if (resolved.chatId !== undefined) updates.chatId = resolved.chatId;
  if (resolved.memoryId !== undefined) updates.memoryId = resolved.memoryId;

  const finalAgent =
    args.agentId !== undefined ? resolved.agentId : actor.agentId;
  const finalChat = args.chatId !== undefined ? resolved.chatId : actor.chatId;
  if (finalAgent && finalChat) {
    throw new DomainError(
      'AGENT_AND_CHAT_EXCLUSIVE',
      'An actor cannot have both an agent_id and a chat_id.'
    );
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
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Actor '${args.id}' not found.`
    );
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
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Actor '${args.id}' not found.`
    );
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
