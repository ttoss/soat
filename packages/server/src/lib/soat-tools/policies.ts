import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-policies',
    description: 'List all global policies (admin only)',
    method: 'GET',
    path: () => {
      return '/policies';
    },
    inputSchema: { type: 'object', properties: {} },
    iamAction: 'policies:ListPolicies',
  },
  {
    name: 'get-policy',
    description: 'Get a global policy by ID (admin only)',
    method: 'GET',
    path: (args) => {
      return `/policies/${args.policyId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        policyId: {
          type: 'string',
          description: 'Policy public ID (pol_ prefix)',
        },
      },
      required: ['policyId'],
    },
    iamAction: 'policies:GetPolicy',
  },
  {
    name: 'create-policy',
    description: 'Create a new global policy (admin only)',
    method: 'POST',
    path: () => {
      return '/policies';
    },
    body: (args) => {
      return {
        name: args.name,
        description: args.description,
        document: args.document,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Policy name' },
        description: { type: 'string', description: 'Policy description' },
        document: {
          type: 'object',
          description:
            'Policy document with statement array. Each statement has effect (Allow|Deny), action (string[]), and optional resource (string[])',
          properties: {
            statement: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  effect: { type: 'string', enum: ['Allow', 'Deny'] },
                  action: { type: 'array', items: { type: 'string' } },
                  resource: { type: 'array', items: { type: 'string' } },
                },
                required: ['effect', 'action'],
              },
            },
          },
          required: ['statement'],
        },
      },
      required: ['document'],
    },
    iamAction: 'policies:CreatePolicy',
  },
  {
    name: 'update-policy',
    description: 'Update an existing global policy (admin only)',
    method: 'PUT',
    path: (args) => {
      return `/policies/${args.policyId}`;
    },
    body: (args) => {
      return {
        name: args.name,
        description: args.description,
        document: args.document,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        policyId: {
          type: 'string',
          description: 'Policy public ID (pol_ prefix)',
        },
        name: { type: 'string', description: 'Policy name' },
        description: { type: 'string', description: 'Policy description' },
        document: {
          type: 'object',
          description: 'Policy document with statement array',
          properties: {
            statement: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  effect: { type: 'string', enum: ['Allow', 'Deny'] },
                  action: { type: 'array', items: { type: 'string' } },
                  resource: { type: 'array', items: { type: 'string' } },
                },
                required: ['effect', 'action'],
              },
            },
          },
          required: ['statement'],
        },
      },
      required: ['policyId', 'document'],
    },
    iamAction: 'policies:UpdatePolicy',
  },
  {
    name: 'delete-policy',
    description: 'Delete a global policy (admin only)',
    method: 'DELETE',
    path: (args) => {
      return `/policies/${args.policyId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        policyId: {
          type: 'string',
          description: 'Policy public ID (pol_ prefix)',
        },
      },
      required: ['policyId'],
    },
    iamAction: 'policies:DeletePolicy',
  },
];
