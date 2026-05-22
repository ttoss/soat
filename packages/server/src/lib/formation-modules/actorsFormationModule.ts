import createDebug from 'debug';

import {
  createActor,
  deleteActor,
  resolveActorLinkedIds,
  updateActor,
  validateActorExclusivity,
} from '../actors';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
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

const log = createDebug('soat:formations:actors');

const SCHEMA_NAME = 'ActorResourceProperties';
const RESOURCE_LABEL = 'actor';

// ── Business rule validation ─────────────────────────────────────────────

const pushBusinessRuleErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  const msg = validateActorExclusivity({
    agentId: args.properties.agent_id,
    chatId: args.properties.chat_id,
  });
  if (msg) {
    args.errors.push({ path: args.basePath, message: msg });
  }
};

// ── Property validation ──────────────────────────────────────────────────

const validateActorProperties = (args: {
  properties: unknown;
  basePath: string;
}): ValidationError[] => {
  const { properties, basePath } = args;
  if (!isObjectRecord(properties)) {
    return [
      { path: basePath, message: 'Actor `properties` must be an object' },
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
  pushBusinessRuleErrors({ properties, basePath, errors });

  return errors;
};

// ── Normalizers ──────────────────────────────────────────────────────────

const requireString = (args: { value: unknown; fieldName: string }): string => {
  if (typeof args.value !== 'string' || args.value.trim().length === 0) {
    throw new Error(
      `Actor field '${args.fieldName}' must be a non-empty string`
    );
  }
  return args.value;
};

export const actorsFormationModule: FormationModule = {
  resourceType: 'actor',

  validateProperties: ({ properties, basePath }) => {
    return validateActorProperties({ properties, basePath });
  },

  create: async ({ properties, projectId }) => {
    const errors = validateActorProperties({
      properties,
      basePath: 'resources.<actor>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const name = requireString({ value: properties.name, fieldName: 'name' });

    const { agentId, chatId, memoryId } = await resolveActorLinkedIds({
      agentId: toNullableString(properties.agent_id),
      chatId: toNullableString(properties.chat_id),
      memoryId: toNullableString(properties.memory_id),
      projectId,
    });

    const created = await createActor({
      projectId,
      name,
      externalId: toOptionalString(properties.external_id),
      instructions: toNullableString(properties.instructions),
      agentId,
      chatId,
      memoryId,
      autoCreateMemory:
        typeof properties.auto_create_memory === 'boolean'
          ? properties.auto_create_memory
          : undefined,
    });

    log(
      'create actor from formation: projectId=%d actorId=%s',
      projectId,
      created.id
    );
    return created.id;
  },

  update: async ({ properties, physicalResourceId }) => {
    const errors = validateActorProperties({
      properties,
      basePath: 'resources.<actor>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    await updateActor({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      externalId: toOptionalString(properties.external_id),
      instructions: toNullableString(properties.instructions),
      agentId: toNullableString(properties.agent_id),
      chatId: toNullableString(properties.chat_id),
      memoryId: toNullableString(properties.memory_id),
    });
  },

  delete: async ({ physicalResourceId }) => {
    await deleteActor({ id: physicalResourceId });
  },
};
