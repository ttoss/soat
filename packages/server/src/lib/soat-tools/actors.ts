import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-actors',
    description:
      'List actors. If projectId is omitted, returns all actors accessible to the caller.',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set('projectId', String(args.projectId));
      if (args.externalId) params.set('externalId', String(args.externalId));
      if (args.name) params.set('name', String(args.name));
      if (args.type) params.set('type', String(args.type));
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      return qs ? `/actors?${qs}` : '/actors';
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to filter by' },
        externalId: {
          type: 'string',
          description: 'External ID to filter by',
        },
        name: { type: 'string', description: 'Name to filter by' },
        type: { type: 'string', description: 'Actor type to filter by' },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
        offset: {
          type: 'number',
          description: 'Number of results to skip',
        },
      },
    },
    iamAction: 'actors:ListActors',
  },
  {
    name: 'get-actor',
    description: 'Get an actor by ID',
    method: 'GET',
    path: (args) => {
      return `/actors/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Actor ID' },
      },
      required: ['id'],
    },
    iamAction: 'actors:GetActor',
  },
  {
    name: 'create-actor',
    description:
      'Create a new actor. Project keys infer the project automatically.',
    method: 'POST',
    path: () => {
      return '/actors';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        name: args.name,
        type: args.type,
        externalId: args.externalId,
        instructions: args.instructions,
        agentId: args.agentId,
        chatId: args.chatId,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Actor name' },
        type: { type: 'string', description: 'Actor type' },
        externalId: { type: 'string', description: 'External identifier' },
        instructions: {
          type: 'string',
          description: 'Instructions for the actor',
        },
        agentId: {
          type: 'string',
          description: 'Agent ID to associate with the actor',
        },
        chatId: {
          type: 'string',
          description: 'Chat ID to associate with the actor',
        },
      },
      required: ['name'],
    },
    iamAction: 'actors:CreateActor',
  },
  {
    name: 'delete-actor',
    description: 'Delete an actor by ID',
    method: 'DELETE',
    path: (args) => {
      return `/actors/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Actor ID' },
      },
      required: ['id'],
    },
    iamAction: 'actors:DeleteActor',
  },
  {
    name: 'update-actor',
    description: 'Update an actor by ID',
    method: 'PATCH',
    path: (args) => {
      return `/actors/${args.id}`;
    },
    body: (args) => {
      return {
        name: args.name,
        type: args.type,
        externalId: args.externalId,
        instructions: args.instructions,
        agentId: args.agentId,
        chatId: args.chatId,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Actor ID' },
        name: { type: 'string', description: 'New actor name' },
        type: { type: 'string', description: 'New actor type' },
        externalId: {
          type: 'string',
          description: 'New external identifier',
        },
        instructions: {
          type: 'string',
          description: 'New instructions for the actor',
        },
        agentId: {
          type: 'string',
          description: 'New agent ID (or null to unset)',
        },
        chatId: {
          type: 'string',
          description: 'New chat ID (or null to unset)',
        },
      },
      required: ['id'],
    },
    iamAction: 'actors:UpdateActor',
  },
];
