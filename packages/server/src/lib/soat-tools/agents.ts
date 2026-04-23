import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  // ── Agent Tools CRUD ────────────────────────────────────────────────────

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

  // ── Agents CRUD ─────────────────────────────────────────────────────────

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

  // ── Generation ──────────────────────────────────────────────────────────

  {
    name: 'create-agent-generation',
    description:
      'Run a generation on an agent. Sends messages and runs the AI loop. ' +
      'Client tools may pause the generation with requires_action.',
    method: 'POST',
    path: (args) => {
      return `/agents/${args.agentId}/generate`;
    },
    body: (args) => {
      return {
        messages: args.messages,
        traceId: args.traceId,
        toolContext: args.toolContext,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['system', 'user', 'assistant'],
              },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
          description: 'Ordered list of messages to send',
        },
        traceId: {
          type: 'string',
          description: 'Optional trace ID to group generations',
        },
        toolContext: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Key-value pairs injected as context headers into all tool call requests made during this generation',
        },
      },
      required: ['agentId', 'messages'],
    },
    iamAction: 'agents:CreateAgentGeneration',
  },
  {
    name: 'submit-agent-tool-outputs',
    description: 'Submit tool outputs to resume a paused agent generation.',
    method: 'POST',
    path: (args) => {
      return `/agents/${args.agentId}/generate/${args.generationId}/tool-outputs`;
    },
    body: (args) => {
      return {
        toolOutputs: args.toolOutputs,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        generationId: {
          type: 'string',
          description: 'Public ID of the paused generation',
        },
        toolOutputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              toolCallId: {
                type: 'string',
                description: 'ID of the tool call to respond to',
              },
              output: { description: 'Result of the tool execution' },
            },
            required: ['toolCallId', 'output'],
          },
          description: 'Tool outputs for each pending tool call',
        },
      },
      required: ['agentId', 'generationId', 'toolOutputs'],
    },
    iamAction: 'agents:SubmitAgentToolOutputs',
  },

  // ── Traces ───────────────────────────────────────────────────────────────

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
