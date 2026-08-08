import {
  createConversation,
  deleteConversation,
  getConversation,
  updateConversation,
} from '../conversations';
import { lookupActorInternalId } from '../formationsHelpers';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const conversationsFormationModule = defineFormationModule({
  resourceType: 'conversation',

  create: async ({ properties, projectId }) => {
    const actorPublicId = toNullableString(properties.actor_id);
    const actorId = actorPublicId
      ? await lookupActorInternalId(actorPublicId)
      : null;

    return createConversation({
      projectId,
      name: toNullableString(properties.name),
      status: toOptionalString(properties.status) ?? undefined,
      actorId,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateConversation({
      id: physicalResourceId,
      name: toNullableString(properties.name),
      status: toOptionalString(properties.status) ?? undefined,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteConversation({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getConversation({ id: physicalResourceId });
  },
});
