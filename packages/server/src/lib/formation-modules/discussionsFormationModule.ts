import createDebug from 'debug';

import {
  createDiscussion,
  deleteDiscussion,
  getDiscussion,
  type ParticipantInput,
  type SynthesisConfig,
  updateDiscussion,
} from '../discussions';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableNumber,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:discussions');

const SCHEMA_NAME = 'DiscussionResourceProperties';
const RESOURCE_LABEL = 'discussion';

const validateDiscussionProperties = (args: {
  properties: unknown;
  basePath: string;
}): ValidationError[] => {
  const { properties, basePath } = args;
  if (!isObjectRecord(properties)) {
    return [
      { path: basePath, message: 'Discussion `properties` must be an object' },
    ];
  }

  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  pushRequiredFieldErrors({ spec, properties, basePath, errors });
  pushFieldTypeErrors({ spec, properties, basePath, errors });
  return errors;
};

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

export const discussionsFormationModule: FormationModule = {
  resourceType: 'discussion',

  validateProperties: ({ properties, basePath }) => {
    return validateDiscussionProperties({ properties, basePath });
  },

  create: async ({ properties, projectId }) => {
    const errors = validateDiscussionProperties({
      properties,
      basePath: 'resources.<discussion>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const created = await createDiscussion({
      projectId,
      name: requireString({ value: properties.name, fieldName: 'name' }),
      aiProviderId: requireString({
        value: properties.ai_provider_id,
        fieldName: 'ai_provider_id',
      }),
      description: toNullableString(properties.description),
      maxRounds: toNullableNumber(properties.max_rounds),
      model: toNullableString(properties.model),
      synthesis: toSynthesis(properties.synthesis),
      participants: toParticipants(properties.participants),
    });

    log(
      'create discussion from formation: projectId=%d discussionId=%s',
      projectId,
      created.id
    );
    return created.id;
  },

  update: async ({ properties, physicalResourceId }) => {
    const errors = validateDiscussionProperties({
      properties,
      basePath: 'resources.<discussion>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

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

  delete: async ({ physicalResourceId }) => {
    await deleteDiscussion({ id: physicalResourceId });
  },

  read: async ({ physicalResourceId }) => {
    try {
      const discussion = await getDiscussion({ id: physicalResourceId });
      return {
        name: discussion.name,
        description: discussion.description,
        max_rounds: discussion.maxRounds,
        ai_provider_id: discussion.aiProviderId,
        model: discussion.model,
        synthesis: discussion.synthesis,
      };
    } catch {
      return null;
    }
  },
};
