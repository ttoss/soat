import type { SoatToolDefinition } from './types';

export const agentsCrudDefinitions: SoatToolDefinition[] = [
  {
    name: 'create-agent',
    description: 'Create a new agent bound to an AI provider.',
    method: 'POST',
    path: () => {
      return '/agents';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        aiProviderId: args.aiProviderId,
        name: args.name,
        instructions: args.instructions,
        model: args.model,
        toolIds: args.toolIds,
        maxSteps: args.maxSteps,
        temperature: args.temperature,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Public ID of the project',
        },
        aiProviderId: {
          type: 'string',
          description: 'Public ID of the AI provider to use',
        },
        name: { type: 'string', description: 'Display name' },
        instructions: {
          type: 'string',
          description: 'System instructions guiding agent behavior',
        },
        model: {
          type: 'string',
          description: 'Model identifier (falls back to AI provider default)',
        },
        toolIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of agent tools to attach',
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum reasoning steps (default: 20)',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature',
        },
      },
      required: ['aiProviderId'],
    },
    iamAction: 'agents:CreateAgent',
  },
  {
    name: 'list-agents',
    description: 'List all agents in a project.',
    method: 'GET',
    path: (args) => {
      const qs = args.projectId
        ? `?projectId=${encodeURIComponent(String(args.projectId))}`
        : '';
      return `/agents${qs}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Public ID of the project to filter by',
        },
      },
    },
    iamAction: 'agents:ListAgents',
  },
  {
    name: 'get-agent',
    description: 'Get an agent by ID.',
    method: 'GET',
    path: (args) => {
      return `/agents/${args.agentId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
      },
      required: ['agentId'],
    },
    iamAction: 'agents:GetAgent',
  },
  {
    name: 'update-agent',
    description: 'Update an existing agent.',
    method: 'PUT',
    path: (args) => {
      return `/agents/${args.agentId}`;
    },
    body: (args) => {
      return {
        aiProviderId: args.aiProviderId,
        name: args.name,
        instructions: args.instructions,
        model: args.model,
        toolIds: args.toolIds,
        maxSteps: args.maxSteps,
        temperature: args.temperature,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Public ID of the agent to update',
        },
        aiProviderId: {
          type: 'string',
          description: 'New AI provider ID',
        },
        name: { type: 'string', description: 'New display name' },
        instructions: {
          type: 'string',
          description: 'New system instructions',
        },
        model: { type: 'string', description: 'New model identifier' },
        toolIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tool IDs',
        },
        maxSteps: { type: 'number', description: 'New max steps' },
        temperature: { type: 'number', description: 'New temperature' },
      },
      required: ['agentId'],
    },
    iamAction: 'agents:UpdateAgent',
  },
  {
    name: 'delete-agent',
    description: 'Delete an agent by ID.',
    method: 'DELETE',
    path: (args) => {
      return `/agents/${args.agentId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Public ID of the agent to delete',
        },
      },
      required: ['agentId'],
    },
    iamAction: 'agents:DeleteAgent',
  },
];
