import type { SoatToolDefinition } from './types';

export const agentToolsDefinitions: SoatToolDefinition[] = [
  {
    name: 'create-agent-tool',
    description: 'Create a new agent tool in the project.',
    method: 'POST',
    path: () => {
      return '/agents/tools';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        name: args.name,
        type: args.type,
        description: args.description,
        parameters: args.parameters,
        execute: args.execute,
        mcp: args.mcp,
        actions: args.actions,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Public ID of the project this tool belongs to',
        },
        name: { type: 'string', description: 'Tool name' },
        type: {
          type: 'string',
          description: 'Tool type: http, client, mcp, or soat (default: http)',
        },
        description: {
          type: 'string',
          description: 'What the tool does (sent to the model)',
        },
        parameters: {
          type: 'object',
          description: 'JSON Schema for tool input (required for http/client)',
        },
        execute: {
          type: 'object',
          description:
            'Execution config with url and headers (required for http)',
        },
        mcp: {
          type: 'object',
          description:
            'MCP server config with url and headers (required for mcp)',
        },
        actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'SOAT platform actions to expose (required for soat)',
        },
      },
      required: ['name'],
    },
    iamAction: 'agents:CreateAgentTool',
  },
  {
    name: 'list-agent-tools',
    description: 'List all agent tools in a project.',
    method: 'GET',
    path: (args) => {
      const qs = args.projectId
        ? `?projectId=${encodeURIComponent(String(args.projectId))}`
        : '';
      return `/agents/tools${qs}`;
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
    iamAction: 'agents:ListAgentTools',
  },
  {
    name: 'get-agent-tool',
    description: 'Get an agent tool by ID.',
    method: 'GET',
    path: (args) => {
      return `/agents/tools/${args.toolId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string', description: 'Public ID of the agent tool' },
      },
      required: ['toolId'],
    },
    iamAction: 'agents:GetAgentTool',
  },
  {
    name: 'update-agent-tool',
    description: 'Update an existing agent tool.',
    method: 'PUT',
    path: (args) => {
      return `/agents/tools/${args.toolId}`;
    },
    body: (args) => {
      return {
        name: args.name,
        type: args.type,
        description: args.description,
        parameters: args.parameters,
        execute: args.execute,
        mcp: args.mcp,
        actions: args.actions,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        toolId: {
          type: 'string',
          description: 'Public ID of the agent tool to update',
        },
        name: { type: 'string', description: 'New tool name' },
        type: { type: 'string', description: 'New tool type' },
        description: { type: 'string', description: 'New description' },
        parameters: {
          type: 'object',
          description: 'New JSON Schema for tool input',
        },
        execute: {
          type: 'object',
          description: 'New execution config',
        },
        mcp: { type: 'object', description: 'New MCP server config' },
        actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'New SOAT actions list',
        },
      },
      required: ['toolId'],
    },
    iamAction: 'agents:UpdateAgentTool',
  },
  {
    name: 'delete-agent-tool',
    description: 'Delete an agent tool by ID.',
    method: 'DELETE',
    path: (args) => {
      return `/agents/tools/${args.toolId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        toolId: {
          type: 'string',
          description: 'Public ID of the agent tool to delete',
        },
      },
      required: ['toolId'],
    },
    iamAction: 'agents:DeleteAgentTool',
  },
];
