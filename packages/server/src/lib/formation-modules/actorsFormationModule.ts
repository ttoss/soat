import {
  createActor,
  deleteActor,
  getActor,
  resolveActorLinkedIds,
  updateActor,
  validateActorExclusivity,
} from '../actors';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

const requireString = (args: { value: unknown; fieldName: string }): string => {
  if (typeof args.value !== 'string' || args.value.trim().length === 0) {
    throw new Error(
      `Actor field '${args.fieldName}' must be a non-empty string`
    );
  }
  return args.value;
};

export const actorsFormationModule = defineFormationModule({
  resourceType: 'actor',
  // An actor's `name` is required on update too: `updateActor` cannot infer a
  // linkage from a bag that names neither the actor nor its target.
  requiredOnUpdate: true,

  extraChecks: ({ properties, basePath, errors }) => {
    const message = validateActorExclusivity({
      agentId: properties.agent_id,
      chatId: properties.chat_id,
    });
    if (message) {
      errors.push({ path: basePath, message });
    }
  },

  create: async ({ properties, projectId }) => {
    const name = requireString({ value: properties.name, fieldName: 'name' });

    const { agentId, chatId, memoryId } = await resolveActorLinkedIds({
      agentId: toNullableString(properties.agent_id),
      chatId: toNullableString(properties.chat_id),
      memoryId: toNullableString(properties.memory_id),
      projectId,
    });

    return createActor({
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
  },

  update: async ({ properties, physicalResourceId }) => {
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

  remove: ({ physicalResourceId }) => {
    return deleteActor({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getActor({ id: physicalResourceId });
  },
});
