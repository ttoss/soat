import {
  createDiscussion,
  deleteDiscussion,
  getDiscussion,
  type ParticipantInput,
  type SynthesisConfig,
  updateDiscussion,
} from '../discussions';
import {
  toNullableNumber,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

const EFFORTS = new Set(['low', 'medium', 'high']);

const toEffort = (value: unknown): 'low' | 'medium' | 'high' | undefined => {
  return typeof value === 'string' && EFFORTS.has(value)
    ? (value as 'low' | 'medium' | 'high')
    : undefined;
};

/** Converts a snake_case template participant into a camelCase input. */
const toParticipant = (raw: unknown): ParticipantInput => {
  const record = isObjectRecord(raw) ? raw : {};
  return {
    name: toNullableString(record.name),
    prompt: toNullableString(record.prompt),
    position: toNullableNumber(record.position) ?? undefined,
    actorId: toNullableString(record.actor_id),
    aiProviderId: toNullableString(record.ai_provider_id),
    model: toNullableString(record.model),
    temperature: toNullableNumber(record.temperature),
    effort: toEffort(record.effort),
  };
};

const toParticipants = (raw: unknown): ParticipantInput[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(toParticipant);
};

const toSynthesis = (raw: unknown): SynthesisConfig | null | undefined => {
  if (raw === null) return null;
  if (!isObjectRecord(raw)) return undefined;
  return {
    aiProviderId: toOptionalString(raw.ai_provider_id),
    model: toOptionalString(raw.model),
    prompt: toOptionalString(raw.prompt),
    effort: toEffort(raw.effort),
  };
};

const requireString = (args: { value: unknown; fieldName: string }): string => {
  if (typeof args.value !== 'string' || args.value.trim().length === 0) {
    throw new Error(
      `Discussion field '${args.fieldName}' must be a non-empty string`
    );
  }
  return args.value;
};

export const discussionsFormationModule = defineFormationModule({
  resourceType: 'discussion',
  // A discussion's `name` is required on update too — `updateDiscussion` has no
  // way to identify the resource from a bag that omits it.
  requiredOnUpdate: true,

  create: ({ properties, projectId }) => {
    return createDiscussion({
      projectId,
      name: requireString({ value: properties.name, fieldName: 'name' }),
      // Absent means the discussion inherits the project's default model route.
      aiProviderId: toOptionalString(properties.ai_provider_id) ?? undefined,
      description: toNullableString(properties.description),
      maxRounds: toNullableNumber(properties.max_rounds),
      model: toNullableString(properties.model),
      synthesis: toSynthesis(properties.synthesis),
      participants: toParticipants(properties.participants),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateDiscussion({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      maxRounds: toNullableNumber(properties.max_rounds),
      aiProviderId: toOptionalString(properties.ai_provider_id),
      model: toNullableString(properties.model),
      synthesis: toSynthesis(properties.synthesis),
      participants: toParticipants(properties.participants),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteDiscussion({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getDiscussion({ id: physicalResourceId });
  },

  read: (discussion) => {
    return {
      name: discussion.name,
      description: discussion.description,
      max_rounds: discussion.max_rounds,
      ai_provider_id: discussion.ai_provider_id,
      model: discussion.model,
      synthesis: discussion.synthesis,
      // Mapped to the same snake_case shape the template declares, omitting
      // `position` (derived from array order, never authored in a template)
      // and any field left at its null default, so a template that only sets
      // the fields it cares about still diffs as a no-op instead of always
      // reporting 'update'.
      participants: discussion.participants.map((participant) => {
        const mapped: Record<string, unknown> = {
          name: participant.name,
          prompt: participant.prompt,
          actor_id: participant.actor_id,
          ai_provider_id: participant.ai_provider_id,
          model: participant.model,
          temperature: participant.temperature,
          effort: participant.effort,
        };
        for (const [key, value] of Object.entries(mapped)) {
          if (value === null) delete mapped[key];
        }
        return mapped;
      }),
    };
  },
});
