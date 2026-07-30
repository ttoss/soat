import { db } from '../db';
import { DomainError } from '../errors';
import type { ParticipantInput, SynthesisConfig } from './discussionsTypes';
import { assertModelBindingResolvable } from './modelRoutes';

/**
 * Provider / actor resolution for discussions: turning the public ids a request
 * names into the internal ids the rows store, plus the model-binding guard.
 *
 * Split out of `discussions.ts` to keep that module inside its line budget; it
 * is the natural seam because every function here maps or validates a reference
 * rather than performing CRUD.
 */

export const resolveProviderId = async (args: {
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

/**
 * Resolves an optional pinned provider to its internal id. `null`/absent means
 * the discussion pins none and resolves through the project default route.
 */
export const resolveOptionalProviderId = async (args: {
  projectId: number;
  aiProviderId?: string | null;
}): Promise<number | null> => {
  return args.aiProviderId
    ? resolveProviderId({
        projectId: args.projectId,
        aiProviderId: args.aiProviderId,
      })
    : null;
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

export const createParticipants = async (args: {
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

/**
 * At most one binding: a discussion that pins no provider inherits its project's
 * `default_model_route_id`, which must therefore exist. A partial update that
 * does not mention `ai_provider_id` leaves the stored binding untouched and so
 * cannot trip the guard.
 */
export const assertDiscussionBinding = async (args: {
  projectId: number;
  aiProviderId?: string | null;
}): Promise<void> => {
  if (args.aiProviderId === undefined) return;
  await assertModelBindingResolvable({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
    modelRouteId: null,
    resourceLabel: 'discussion',
  });
};

export const assertSynthesisProvider = async (args: {
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
