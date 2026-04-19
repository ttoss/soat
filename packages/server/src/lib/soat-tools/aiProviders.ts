import type { SoatToolDefinition } from './types';

const AI_PROVIDER_SLUGS = [
  'anthropic',
  'openai',
  'groq',
  'google',
  'xai',
  'amazon-bedrock',
  'azure',
] as const;

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-ai-providers',
    description: 'List AI providers in a project.',
    method: 'GET',
    path: (args) => {
      const qs = args.projectId
        ? `?projectId=${encodeURIComponent(String(args.projectId))}`
        : '';
      return `/ai-providers${qs}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID to filter by',
        },
      },
    },
    iamAction: 'aiProviders:ListAiProviders',
  },
  {
    name: 'get-ai-provider',
    description: 'Get an AI provider by ID.',
    method: 'GET',
    path: (args) => {
      return `/ai-providers/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'AI provider ID' },
      },
      required: ['id'],
    },
    iamAction: 'aiProviders:GetAiProvider',
  },
  {
    name: 'create-ai-provider',
    description: 'Create a new AI provider configuration.',
    method: 'POST',
    path: () => {
      return '/ai-providers';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        secretId: args.secretId,
        name: args.name,
        provider: args.provider,
        defaultModel: args.defaultModel,
        baseUrl: args.baseUrl,
        config: args.config,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        secretId: {
          type: 'string',
          description: 'Secret ID holding the API key',
        },
        name: { type: 'string', description: 'Display name' },
        provider: {
          type: 'string',
          enum: AI_PROVIDER_SLUGS as unknown as string[],
          description: 'AI provider slug',
        },
        defaultModel: {
          type: 'string',
          description: 'Default model identifier',
        },
        baseUrl: {
          type: 'string',
          description: 'Custom base URL (optional)',
        },
        config: {
          type: 'object',
          description: 'Additional provider-specific configuration',
        },
      },
      required: ['name', 'provider', 'defaultModel'],
    },
    iamAction: 'aiProviders:CreateAiProvider',
  },
  {
    name: 'update-ai-provider',
    description: 'Update an AI provider configuration.',
    method: 'PATCH',
    path: (args) => {
      return `/ai-providers/${args.id}`;
    },
    body: (args) => {
      return {
        secretId: args.secretId,
        name: args.name,
        provider: args.provider,
        defaultModel: args.defaultModel,
        baseUrl: args.baseUrl,
        config: args.config,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'AI provider ID' },
        secretId: {
          type: 'string',
          description: 'New secret ID holding the API key',
        },
        name: { type: 'string', description: 'New display name' },
        provider: {
          type: 'string',
          enum: AI_PROVIDER_SLUGS as unknown as string[],
          description: 'New AI provider slug',
        },
        defaultModel: {
          type: 'string',
          description: 'New default model identifier',
        },
        baseUrl: { type: 'string', description: 'New custom base URL' },
        config: {
          type: 'object',
          description: 'New provider-specific configuration',
        },
      },
      required: ['id'],
    },
    iamAction: 'aiProviders:UpdateAiProvider',
  },
  {
    name: 'delete-ai-provider',
    description: 'Delete an AI provider.',
    method: 'DELETE',
    path: (args) => {
      return `/ai-providers/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'AI provider ID' },
      },
      required: ['id'],
    },
    iamAction: 'aiProviders:DeleteAiProvider',
  },
];
