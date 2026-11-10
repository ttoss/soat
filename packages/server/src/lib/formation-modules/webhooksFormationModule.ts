import {
  toNullableArray,
  toNullableRecord,
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

  create: ({ properties, projectId, actor }) => {
    return createWebhook({
      projectId,
      policyIds: toNullableArray<string>(properties.policy_ids) ?? undefined,
      name: properties.name as string,
      url: properties.url as string,
      events: properties.events as string[],
      eventResources:
        toNullableArray<string>(properties.event_resources) ?? undefined,
      eventData: toNullableRecord(properties.event_data) ?? undefined,
      description: toOptionalString(properties.description) ?? undefined,
      writerPolicies: actor.getPolicies,
    });
  },

  update: async ({ properties, physicalResourceId, actor }) => {
    await updateWebhook({
      id: physicalResourceId,
      policyIds: toNullableArray<string>(properties.policy_ids) ?? undefined,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description) ?? undefined,
      url: toOptionalString(properties.url),
      // `events` is required by WebhookResourceProperties and validated above.
      events: properties.events as string[],
      eventResources: toNullableArray<string>(properties.event_resources),
      eventData: toNullableRecord(properties.event_data),
      writerPolicies: actor.getPolicies,
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
