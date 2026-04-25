import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'create-api-key',
    description:
      'Create a new API key for the current user. Optionally scope it to a project and/or attach policies. The raw key value is only returned once.',
    method: 'POST',
    path: () => '/api-keys',
    body: (args) => ({
      name: args.name,
      project_id: args.projectId,
      policy_ids: args.policyIds,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Key name for identification' },
        projectId: {
          type: 'string',
          description:
            'Optional project ID to scope this key to a specific project',
        },
        policyIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of policy public IDs to attach. Key permissions become the intersection of user policies and these policies.',
        },
      },
      required: ['name'],
    },
    iamAction: 'apiKeys:CreateApiKey',
  },
  {
    name: 'get-api-key',
    description: 'Get an API key by ID (owner or admin only)',
    method: 'GET',
    path: (args) => `/api-keys/${args.id}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'API key public ID (key_ prefix)' },
      },
      required: ['id'],
    },
    iamAction: 'apiKeys:GetApiKey',
  },
  {
    name: 'update-api-key',
    description:
      'Update an API key name, project scope, or policies (owner or admin only)',
    method: 'PUT',
    path: (args) => `/api-keys/${args.id}`,
    body: (args) => ({
      name: args.name,
      project_id: args.projectId,
      policy_ids: args.policyIds,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'API key public ID (key_ prefix)' },
        name: { type: 'string', description: 'New key name' },
        projectId: {
          type: 'string',
          description:
            'Project ID to scope this key to (set to empty string to remove scope)',
        },
        policyIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Replace the key policy list (empty array removes all policies)',
        },
      },
      required: ['id'],
    },
    iamAction: 'apiKeys:UpdateApiKey',
  },
  {
    name: 'delete-api-key',
    description: 'Delete an API key (owner or admin only)',
    method: 'DELETE',
    path: (args) => `/api-keys/${args.id}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'API key public ID (key_ prefix)' },
      },
      required: ['id'],
    },
    iamAction: 'apiKeys:DeleteApiKey',
  },
];
