import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-webhooks',
    description: 'List webhooks for a project.',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      return qs
        ? `/projects/${args.projectId}/webhooks?${qs}`
        : `/projects/${args.projectId}/webhooks`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
      },
      required: ['projectId'],
    },
    iamAction: 'webhooks:ListWebhooks',
  },
  {
    name: 'get-webhook',
    description: 'Get a webhook by ID.',
    method: 'GET',
    path: (args) => {
      return `/projects/${args.projectId}/webhooks/${args.webhookId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        webhookId: { type: 'string', description: 'Webhook ID' },
      },
      required: ['projectId', 'webhookId'],
    },
    iamAction: 'webhooks:GetWebhook',
  },
  {
    name: 'create-webhook',
    description: 'Create a new webhook for a project.',
    method: 'POST',
    path: (args) => {
      return `/projects/${args.projectId}/webhooks`;
    },
    body: (args) => {
      return {
        name: args.name,
        description: args.description,
        url: args.url,
        events: args.events,
        policyId: args.policyId,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Webhook name' },
        description: { type: 'string', description: 'Webhook description' },
        url: {
          type: 'string',
          description: 'HTTPS delivery endpoint URL',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Event patterns to subscribe to (e.g., files.created, documents.*)',
        },
        policyId: {
          type: 'string',
          description: 'Optional policy ID to scope webhook events',
        },
      },
      required: ['projectId', 'name', 'url', 'events'],
    },
    iamAction: 'webhooks:CreateWebhook',
  },
  {
    name: 'update-webhook',
    description: 'Update an existing webhook.',
    method: 'PUT',
    path: (args) => {
      return `/projects/${args.projectId}/webhooks/${args.webhookId}`;
    },
    body: (args) => {
      return {
        name: args.name,
        description: args.description,
        url: args.url,
        events: args.events,
        active: args.active,
        policyId: args.policyId,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        webhookId: { type: 'string', description: 'Webhook ID' },
        name: { type: 'string', description: 'New webhook name' },
        description: { type: 'string', description: 'New description' },
        url: { type: 'string', description: 'New delivery endpoint URL' },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'New event patterns',
        },
        active: { type: 'boolean', description: 'Enable or disable webhook' },
        policyId: {
          type: 'string',
          description: 'New policy ID (or null to remove)',
        },
      },
      required: ['projectId', 'webhookId'],
    },
    iamAction: 'webhooks:UpdateWebhook',
  },
  {
    name: 'delete-webhook',
    description: 'Delete a webhook by ID.',
    method: 'DELETE',
    path: (args) => {
      return `/projects/${args.projectId}/webhooks/${args.webhookId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        webhookId: { type: 'string', description: 'Webhook ID' },
      },
      required: ['projectId', 'webhookId'],
    },
    iamAction: 'webhooks:DeleteWebhook',
  },
  {
    name: 'rotate-webhook-secret',
    description: 'Rotate the HMAC signing secret for a webhook.',
    method: 'POST',
    path: (args) => {
      return `/projects/${args.projectId}/webhooks/${args.webhookId}/rotate-secret`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        webhookId: { type: 'string', description: 'Webhook ID' },
      },
      required: ['projectId', 'webhookId'],
    },
    iamAction: 'webhooks:RotateWebhookSecret',
  },
  {
    name: 'list-webhook-deliveries',
    description: 'List delivery attempts for a webhook.',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      return qs
        ? `/projects/${args.projectId}/webhooks/${args.webhookId}/deliveries?${qs}`
        : `/projects/${args.projectId}/webhooks/${args.webhookId}/deliveries`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        webhookId: { type: 'string', description: 'Webhook ID' },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
        offset: { type: 'number', description: 'Number of results to skip' },
      },
      required: ['projectId', 'webhookId'],
    },
    iamAction: 'webhooks:ListWebhookDeliveries',
  },
  {
    name: 'get-webhook-delivery',
    description: 'Get a specific webhook delivery by ID.',
    method: 'GET',
    path: (args) => {
      return `/projects/${args.projectId}/webhooks/${args.webhookId}/deliveries/${args.deliveryId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        webhookId: { type: 'string', description: 'Webhook ID' },
        deliveryId: { type: 'string', description: 'Delivery ID' },
      },
      required: ['projectId', 'webhookId', 'deliveryId'],
    },
    iamAction: 'webhooks:GetWebhookDelivery',
  },
];
