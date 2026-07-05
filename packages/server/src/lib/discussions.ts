import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type DiscussionModel,
  type ParticipantInput,
  type SynthesisConfig,
} from './discussionsTypes';
import { validateDiscussionConfig } from './discussionsValidation';
import { registerResourceFieldMap } from './policyCompiler';

const log = createDebug('soat:discussions');

registerResourceFieldMap({
  resourceType: 'discussion',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

// Re-exported so existing importers keep resolving from this module.
export {
  type DiscussionModel,
  type ParticipantInput,
  type SynthesisConfig,
} from './discussionsTypes';
export { validateDiscussionConfig } from './discussionsValidation';

// ── Mapping ──────────────────────────────────────────────────────────────────

const mapParticipant = (
  participant: NonNullable<DiscussionModel['participants']>[number]
) => {
  return {
    id: participant.publicId,
    name: participant.name ?? null,
    prompt: participant.prompt ?? null,
    position: participant.position,
    actorId: participant.actor?.publicId ?? null,
    aiProviderId: participant.aiProvider?.publicId ?? null,
    model: participant.model ?? null,
    temperature: participant.temperature ?? null,
    effort: participant.effort ?? null,
  };
};

export const mapDiscussion = (discussion: DiscussionModel) => {
  const participants = (discussion.participants ?? [])
    .slice()
    .sort((a, b) => {
      return a.position - b.position;
    })
    .map(mapParticipant);
  return {
    id: discussion.publicId,
    projectId: discussion.project?.publicId,
    name: discussion.name,
    description: discussion.description ?? null,
    maxRounds: discussion.maxRounds,
    aiProviderId: discussion.aiProvider?.publicId ?? null,
    model: discussion.model ?? null,
    synthesis: discussion.synthesis ?? null,
    tags: discussion.tags ?? undefined,
    participants,
    createdAt: discussion.createdAt,
    updatedAt: discussion.updatedAt,
  };
};

const discussionIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.AiProvider, as: 'aiProvider' },
    {
      model: db.DiscussionParticipant,
      as: 'participants',
      include: [
        { model: db.Actor, as: 'actor' },
        { model: db.AiProvider, as: 'aiProvider' },
      ],
    },
  ];
};

/** Loads a discussion with its participants + providers (raw model). */
export const findDiscussionModel = async (
  publicId: string
): Promise<DiscussionModel | null> => {
  const discussion = await db.Discussion.findOne({
    where: { publicId },
    include: discussionIncludes(),
  });
  return (discussion as DiscussionModel) ?? null;
};

const getDiscussionByDbId = async (id: number) => {
  const created = await db.Discussion.findOne({
    where: { id },
    include: discussionIncludes(),
  });
  return mapDiscussion(created as DiscussionModel);
};

// ── Provider / actor resolution ───────────────────────────────────────────────

const resolveProviderId = async (args: {
  projectId: number;
  aiProviderId: string;
}): Promise<number> => {
  const provider = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId, projectId: args.projectId },
  });
  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found in the project.`
    );
  }
  return provider.id as number;
};

const resolveActorId = async (args: {
  projectId: number;
  actorId: string;
}): Promise<number> => {
  const actor = await db.Actor.findOne({
    where: { publicId: args.actorId, projectId: args.projectId },
  });
  if (!actor) {
    throw new DomainError(
      'ACTOR_NOT_FOUND',
      `Actor '${args.actorId}' not found in the project.`
    );
  }
  return actor.id as number;
};

const buildParticipantAttributes = async (args: {
  discussionId: number;
  projectId: number;
  participant: ParticipantInput;
  index: number;
}) => {
  const { participant } = args;
  const aiProviderId = participant.aiProviderId
    ? await resolveProviderId({
        projectId: args.projectId,
        aiProviderId: participant.aiProviderId,
      })
    : null;
  const actorId = participant.actorId
    ? await resolveActorId({
        projectId: args.projectId,
        actorId: participant.actorId,
      })
    : null;
  return {
    discussionId: args.discussionId,
    name: participant.name ?? null,
    prompt: participant.prompt ?? null,
    position: participant.position ?? args.index,
    actorId,
    aiProviderId,
    model: participant.model ?? null,
    temperature: participant.temperature ?? null,
    effort: participant.effort ?? null,
  };
};

const createParticipants = async (args: {
  discussionId: number;
  projectId: number;
  participants: ParticipantInput[];
}): Promise<void> => {
  for (let index = 0; index < args.participants.length; index++) {
    const attributes = await buildParticipantAttributes({
      discussionId: args.discussionId,
      projectId: args.projectId,
      participant: args.participants[index],
      index,
    });
    await db.DiscussionParticipant.create(attributes);
  }
};

const assertSynthesisProvider = async (args: {
  projectId: number;
  synthesis?: SynthesisConfig | null;
}): Promise<void> => {
  if (args.synthesis?.aiProviderId) {
    await resolveProviderId({
      projectId: args.projectId,
      aiProviderId: args.synthesis.aiProviderId,
    });
  }
};

// ── CRUD ───────────────────────────────────────────────────────────────────

export const createDiscussion = async (args: {
  projectId: number;
  name: string;
  aiProviderId: string;
  description?: string | null;
  maxRounds?: number | null;
  model?: string | null;
  synthesis?: SynthesisConfig | null;
  tags?: Record<string, string> | null;
  participants?: ParticipantInput[];
}) => {
  log(
    'createDiscussion: projectId=%d name=%s participants=%d',
    args.projectId,
    args.name,
    args.participants?.length ?? 0
  );

  validateDiscussionConfig({
    maxRounds: args.maxRounds,
    participants: args.participants,
    synthesis: args.synthesis,
  });

  const aiProviderId = await resolveProviderId({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
  });
  await assertSynthesisProvider({
    projectId: args.projectId,
    synthesis: args.synthesis,
  });

  const discussion = await db.Discussion.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    maxRounds: args.maxRounds ?? 1,
    aiProviderId,
    model: args.model ?? null,
    synthesis: args.synthesis ?? null,
    tags: args.tags ?? {},
  });

  if (args.participants) {
    await createParticipants({
      discussionId: discussion.id as number,
      projectId: args.projectId,
      participants: args.participants,
    });
  }

  return getDiscussionByDbId(discussion.id as number);
};

export const listDiscussions = async (args: {
  projectIds?: number[];
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
  if (args.policyWhere) {
    Object.assign(where, args.policyWhere);
  }

  const { count, rows } = await db.Discussion.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: discussionIncludes(),
    limit,
    offset,
    order: [['createdAt', 'DESC']],
    distinct: true,
  });

  return {
    data: rows.map((row) => {
      return mapDiscussion(row as DiscussionModel);
    }),
    total: count,
    limit,
    offset,
  };
};

export const getDiscussion = async (args: { id: string }) => {
  const discussion = await db.Discussion.findOne({
    where: { publicId: args.id },
    include: discussionIncludes(),
  });
  if (!discussion) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Discussion '${args.id}' not found.`
    );
  }
  return mapDiscussion(discussion as DiscussionModel);
};

const buildDiscussionUpdates = async (args: {
  projectId: number;
  name?: string;
  description?: string | null;
  maxRounds?: number | null;
  aiProviderId?: string;
  model?: string | null;
  synthesis?: SynthesisConfig | null;
  tags?: Record<string, string> | null;
}): Promise<Record<string, unknown>> => {
  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.description !== undefined) updates.description = args.description;
  if (args.maxRounds !== undefined && args.maxRounds !== null) {
    updates.maxRounds = args.maxRounds;
  }
  if (args.model !== undefined) updates.model = args.model;
  if (args.synthesis !== undefined) updates.synthesis = args.synthesis;
  if (args.tags !== undefined) updates.tags = args.tags ?? {};
  if (args.aiProviderId !== undefined) {
    updates.aiProviderId = await resolveProviderId({
      projectId: args.projectId,
      aiProviderId: args.aiProviderId,
    });
  }
  return updates;
};

export const updateDiscussion = async (args: {
  id: string;
  name?: string;
  description?: string | null;
  maxRounds?: number | null;
  aiProviderId?: string;
  model?: string | null;
  synthesis?: SynthesisConfig | null;
  tags?: Record<string, string> | null;
  participants?: ParticipantInput[];
}) => {
  const discussion = await db.Discussion.findOne({
    where: { publicId: args.id },
  });
  if (!discussion) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Discussion '${args.id}' not found.`
    );
  }

  validateDiscussionConfig({
    maxRounds: args.maxRounds,
    participants: args.participants,
    synthesis: args.synthesis,
  });

  const projectId = discussion.projectId as number;
  await assertSynthesisProvider({ projectId, synthesis: args.synthesis });

  const updates = await buildDiscussionUpdates({ ...args, projectId });
  await discussion.update(updates);

  if (args.participants !== undefined) {
    await db.DiscussionParticipant.destroy({
      where: { discussionId: discussion.id },
    });
    await createParticipants({
      discussionId: discussion.id as number,
      projectId,
      participants: args.participants,
    });
  }

  return getDiscussionByDbId(discussion.id as number);
};

export const deleteDiscussion = async (args: { id: string }) => {
  const discussion = await db.Discussion.findOne({
    where: { publicId: args.id },
  });
  if (!discussion) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Discussion '${args.id}' not found.`
    );
  }
  await db.DiscussionParticipant.destroy({
    where: { discussionId: discussion.id },
  });
  await discussion.destroy();
};
