import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  assertDiscussionBinding,
  assertSynthesisProvider,
  createParticipants,
  resolveOptionalProviderId,
} from './discussionsResolvers';
import {
  type DiscussionModel,
  type ParticipantInput,
  type SynthesisConfig,
} from './discussionsTypes';
import {
  findDiscussionTemplateWarnings,
  validateDiscussionConfig,
} from './discussionsValidation';
import { assertModelBindingResolvable } from './modelRoutes';
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
export {
  findDiscussionTemplateWarnings,
  validateDiscussionConfig,
} from './discussionsValidation';

// ── Mapping ──────────────────────────────────────────────────────────────────

/**
 * The discussion's `synthesis` config is stored as a raw JSON blob (no DB
 * columns to convert case for us), and its `aiProviderId` is read internally
 * as camelCase (see `assertSynthesisProvider`). The wire contract
 * (`SynthesisConfig` in discussions.yaml) is snake_case, so the stored
 * camelCase config must be converted back on the way out — mirrors
 * `discussionsFormationModule.ts`'s `toSynthesis`, which does the same
 * conversion in reverse for formation templates.
 */
const toWireSynthesis = (
  synthesis: SynthesisConfig | null | undefined
): Record<string, unknown> | null => {
  if (!synthesis) return null;
  return {
    ai_provider_id: synthesis.aiProviderId ?? null,
    model: synthesis.model ?? null,
    prompt: synthesis.prompt ?? null,
    effort: synthesis.effort ?? null,
  };
};

const mapParticipant = (
  participant: NonNullable<DiscussionModel['participants']>[number]
) => {
  return {
    id: participant.publicId,
    name: participant.name ?? null,
    prompt: participant.prompt ?? null,
    position: participant.position,
    actor_id: participant.actor?.publicId ?? null,
    ai_provider_id: participant.aiProvider?.publicId ?? null,
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
    project_id: discussion.project?.publicId,
    name: discussion.name,
    description: discussion.description ?? null,
    max_rounds: discussion.maxRounds,
    ai_provider_id: discussion.aiProvider?.publicId ?? null,
    model: discussion.model ?? null,
    synthesis: toWireSynthesis(discussion.synthesis as SynthesisConfig | null),
    tags: discussion.tags ?? undefined,
    participants,
    template_warnings: findDiscussionTemplateWarnings({
      participants,
      synthesis: discussion.synthesis as SynthesisConfig | null,
    }),
    created_at: discussion.createdAt,
    updated_at: discussion.updatedAt,
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

// ── CRUD ───────────────────────────────────────────────────────────────────

export const createDiscussion = async (args: {
  projectId: number;
  name: string;
  aiProviderId?: string;
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

  // At most one binding: a discussion that pins no provider inherits its
  // project's `default_model_route_id`, which must therefore exist.
  await assertModelBindingResolvable({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
    modelRouteId: null,
    resourceLabel: 'discussion',
  });

  const aiProviderId = await resolveOptionalProviderId({
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
  aiProviderId?: string | null;
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
    // An explicit `null` unpins the discussion, handing resolution to the
    // project default route.
    updates.aiProviderId = await resolveOptionalProviderId(args);
  }
  return updates;
};

export const updateDiscussion = async (args: {
  id: string;
  name?: string;
  description?: string | null;
  maxRounds?: number | null;
  aiProviderId?: string | null;
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
  await assertDiscussionBinding({ projectId, aiProviderId: args.aiProviderId });
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
