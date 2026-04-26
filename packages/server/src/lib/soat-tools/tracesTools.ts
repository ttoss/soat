import type { SoatToolDefinition } from './types';

export const tracesDefinitions: SoatToolDefinition[] = [
  {
    name: 'list-agent-traces',
    description: 'List agent traces in a project.',
    method: 'GET',
    path: (args) => {
      const qs = args.projectId
        ? `?projectId=${encodeURIComponent(String(args.projectId))}`
        : '';
      return `/agents/traces${qs}`;
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
    iamAction: 'agents:ListAgentTraces',
  },
  {
    name: 'get-agent-trace',
    description: 'Get an agent trace by ID.',
    method: 'GET',
    path: (args) => {
      return `/agents/traces/${args.traceId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        traceId: { type: 'string', description: 'Public ID of the trace' },
      },
      required: ['traceId'],
    },
    iamAction: 'agents:GetAgentTrace',
  },
];
