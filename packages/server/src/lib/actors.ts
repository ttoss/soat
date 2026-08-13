import createDebug from 'debug';

import { db } from '../db';
import { DomainError, type ErrorCode } from '../errors';
import {
  applyActorRelationshipFilters,
  buildActorListWhere,
} from './actorFilters';
import { createMemory } from './memories';
import type { ResourceIncludes } from './modelIncludes';
import { emptyPage, paginatedList } from './pagination';
import {
  type CompiledPolicy,
  registerResourceFieldMap,
} from './policyCompiler';
import { makeResourceAccessor } from './resourceAccessor';
import { mergeTags } from './tags';

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

type ActorRow = InstanceType<(typeof db)['Actor']> & {
  project?: InstanceType<(typeof db)['Project']>;
  agent?: InstanceType<(typeof db)['Agent']> | null;
  chat?: InstanceType<(typeof db)['Chat']> | null;
  memory?: InstanceType<(typeof db)['Memory']> | null;
};

const mapActor = (actor: ActorRow) => {
  return {
    id: actor.publicId,
    project_id: actor.project?.publicId,
    name: actor.name,
    external_id: actor.externalId ?? undefined,
    instructions: actor.instructions ?? null,
    agent_id: getLinkedPublicId(actor.agent),
    chat_id: getLinkedPublicId(actor.chat),
    memory_id: getLinkedPublicId(actor.memory),
    tags: actor.tags ?? undefined,
    created_at: actor.createdAt,
    updated_at: actor.updatedAt,
  };
};

const actorIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Chat, as: 'chat' },
    { model: db.Memory, as: 'memory' },
  ];
};

const actors = makeResourceAccessor<ActorRow>({
  model: () => {
    return db.Actor;
  },
  includes: actorIncludes,
  label: 'Actor',
});

export const validateActorExclusivity = (args: {
  agentId: unknown;
  chatId: unknown;
}): string | null => {
  if (args.agentId && args.chatId) {
    return 'agentId and chatId are mutually exclusive';
  }
  return null;
};

const resolveSingleLinkedId = async (args: {
  publicId?: string | null;
  projectId?: number;
  findFn: (where: Record<string, unknown>) => Promise<{ id?: unknown } | null>;
  errorCode: ErrorCode;
  notFoundMessage: string;
}): Promise<number | null | undefined> => {
  if (args.publicId === undefined) return undefined;
  if (args.publicId === null) return null;
  const where: Record<string, unknown> = { publicId: args.publicId };
  if (args.projectId !== undefined) where.projectId = args.projectId;
  const entity = await args.findFn(where);
  if (!entity) throw new DomainError(args.errorCode, args.notFoundMessage);
  return entity.id as number;
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
  log('resolveActorLinkedIds %o', args);
  const [agentId, chatId, memoryId] = await Promise.all([
    resolveSingleLinkedId({
      publicId: args.agentId,
      projectId: args.projectId,
      findFn: (where) => {
        return db.Agent.findOne({ where });
      },
      errorCode: 'AGENT_NOT_FOUND',
      notFoundMessage: `Agent '${args.agentId}' not found.`,
    }),
    resolveSingleLinkedId({
      publicId: args.chatId,
      projectId: args.projectId,
      findFn: (where) => {
        return db.Chat.findOne({ where });
      },
      errorCode: 'CHAT_NOT_FOUND',
      notFoundMessage: `Chat '${args.chatId}' not found.`,
    }),
    resolveSingleLinkedId({
      publicId: args.memoryId,
      projectId: args.projectId,
      findFn: (where) => {
        return db.Memory.findOne({ where });
      },
      errorCode: 'MEMORY_NOT_FOUND',
      notFoundMessage: `Memory '${args.memoryId}' not found.`,
    }),
  ]);
  return { agentId, chatId, memoryId };
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
  agentId?: string;
  chatId?: string;
  conversationId?: string;
  policyWhere?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return emptyPage(args);
  }

  const where = buildActorListWhere({
    projectIds: args.projectIds,
    externalId: args.externalId,
    name: args.name,
  });

  if (args.policyWhere) {
    Object.assign(where, args.policyWhere);
  }

  // Relationship filters; an unresolvable filter yields an empty page.
  const resolved = await applyActorRelationshipFilters({
    where,
    agentId: args.agentId,
    chatId: args.chatId,
    conversationId: args.conversationId,
  });
  if (!resolved) {
    return emptyPage(args);
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Actor.findAndCountAll({
        where: Object.keys(where).length > 0 ? where : undefined,
        include: actorIncludes(),
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapActor,
  });
};

export const getActor = async (args: { id: string }) => {
  return mapActor(await actors.getByPublicId({ id: args.id }));
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
  log('createActor %o', args);

  if (args.agentId && args.chatId) {
    throw new DomainError(
      'AGENT_AND_CHAT_EXCLUSIVE',
      'An actor cannot have both an agent_id and a chat_id.'
    );
  }

  let resolvedMemoryId = args.memoryId ?? null;
  if (args.autoCreateMemory && resolvedMemoryId === null) {
    log('createActor: auto-creating memory for actor name=%s', args.name);
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

  const created = await actors.reload(actor);

  log('createActor: created actor id=%s', created.publicId);
  return mapActor(created);
};

const attachMemoryToActor = async (args: {
  actor: InstanceType<(typeof db)['Actor']>;
  projectId: number;
  name: string;
}) => {
  log('attachMemoryToActor: auto-creating memory name=%s', args.name);
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
  log('findOrCreateActor %o', args);

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

  return { actor: mapActor(await actors.reload(actor)), created };
};

export const deleteActor = async (args: { id: string }) => {
  log('deleteActor: id=%s', args.id);

  const actor = await actors.getByPublicId({ id: args.id });

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
  log('updateActor %o', args);

  const actor = await actors.getByPublicId({ id: args.id });

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
  return mapActor(await actors.reload(actor));
};

export const getActorTags = async (args: { id: string }) => {
  const actor = await actors.getByPublicId({ id: args.id });
  return actor.tags ?? {};
};

export const updateActorTags = async (args: {
  id: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const actor = await actors.getByPublicId({ id: args.id });

  const newTags = mergeTags({
    current: actor.tags,
    incoming: args.tags,
    merge: args.merge,
  });
  await actor.update({ tags: newTags });

  // The tag routes' contract is the tag map itself, not the actor resource.
  return newTags;
};
