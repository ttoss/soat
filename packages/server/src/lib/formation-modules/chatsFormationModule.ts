import { createChat, deleteChat, getChat } from '../chats';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

// Chats do not support updates: declaring no `update` makes an apply validate
// the properties and then no-op, rather than reporting a change it never made.
export const chatsFormationModule = defineFormationModule({
  resourceType: 'chat',

  create: ({ properties, projectId }) => {
    return createChat({
      projectId,
      // Absent means the chat inherits the project's default model route.
      aiProviderId: toOptionalString(properties.ai_provider_id) ?? undefined,
      name: toOptionalString(properties.name) ?? undefined,
      instructions: toNullableString(properties.instructions) ?? undefined,
      model: toNullableString(properties.model) ?? undefined,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteChat({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getChat({ id: physicalResourceId });
  },
});
