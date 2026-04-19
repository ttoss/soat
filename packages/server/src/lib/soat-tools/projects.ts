import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-projects',
    description: 'List all projects accessible to the current user',
    method: 'GET',
    path: () => {
      return '/projects';
    },
    inputSchema: { type: 'object', properties: {} },
    iamAction: 'projects:ListProjects',
  },
  {
    name: 'get-project',
    description: 'Get a project by ID',
    method: 'GET',
    path: (args) => {
      return `/projects/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project ID' },
      },
      required: ['id'],
    },
    iamAction: 'projects:GetProject',
  },
];
