import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-secrets',
    description:
      'List secrets. If projectId is omitted, returns all secrets accessible to the caller.',
    method: 'GET',
    path: (args) => {
      const qs = args.projectId
        ? `?projectId=${encodeURIComponent(String(args.projectId))}`
        : '';
      return `/secrets${qs}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to filter by' },
      },
    },
    iamAction: 'secrets:ListSecrets',
  },
  {
    name: 'get-secret',
    description: 'Get a secret by ID (value is never returned)',
    method: 'GET',
    path: (args) => {
      return `/secrets/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Secret ID' },
      },
      required: ['id'],
    },
    iamAction: 'secrets:GetSecret',
  },
  {
    name: 'create-secret',
    description: 'Create a new encrypted secret.',
    method: 'POST',
    path: () => {
      return '/secrets';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        name: args.name,
        value: args.value,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Secret name' },
        value: {
          type: 'string',
          description: 'Secret value (will be encrypted)',
        },
      },
      required: ['name', 'value'],
    },
    iamAction: 'secrets:CreateSecret',
  },
  {
    name: 'update-secret',
    description: 'Update a secret name or value.',
    method: 'PATCH',
    path: (args) => {
      return `/secrets/${args.id}`;
    },
    body: (args) => {
      return {
        name: args.name,
        value: args.value,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Secret ID' },
        name: { type: 'string', description: 'New secret name' },
        value: { type: 'string', description: 'New secret value' },
      },
      required: ['id'],
    },
    iamAction: 'secrets:UpdateSecret',
  },
  {
    name: 'delete-secret',
    description: 'Delete a secret by ID.',
    method: 'DELETE',
    path: (args) => {
      const qs = args.force ? '?force=true' : '';
      return `/secrets/${args.id}${qs}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Secret ID' },
        force: {
          type: 'boolean',
          description:
            'Force delete even if the secret is referenced by other resources',
        },
      },
      required: ['id'],
    },
    iamAction: 'secrets:DeleteSecret',
  },
];
