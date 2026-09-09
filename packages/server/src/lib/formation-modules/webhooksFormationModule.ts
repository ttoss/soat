import {
  toNullableArray,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  updateWebhook,
} from '../webhooks';
import { defineFormationModule } from './defineFormationModule';

export const webhooksFormationModule = defineFormationModule({
  resourceType: 'webhook',
  authorization: {
    srnResourceType: 'webhook',
    create: 'webhooks:CreateWebhook',
    update: 'webhooks:UpdateWebhook',
    delete: 'webhooks:DeleteWebhook',
  },

  create: ({ properties, projectId }) => {
    return createWebhook({
      projectId,
      name: properties.name as string,
      url: properties.url as string,
      events: properties.events as string[],
      description: toOptionalString(properties.description) ?? undefined,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateWebhook({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      description: toNullableString(properties.description) ?? undefined,
      url: toOptionalString(properties.url) ?? undefined,
      events: (toNullableArray(properties.events) ?? undefined) as
        string[] | undefined,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteWebhook({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getWebhook({ id: physicalResourceId });
  },

  sensitiveAttributes: ['secret'],
});
