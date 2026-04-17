import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  // ── Agent Tools CRUD ─────────────────────────────────────────────────────

  server.registerTool(
    'create-agent-tool',
    {
      description: 'Create a new agent tool in the project.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Public ID of the project this tool belongs to'),
        name: z.string().describe('Tool name'),
        type: z
          .string()
          .optional()
          .describe('Tool type: http, client, mcp, or soat (default: http)'),
        description: z
          .string()
          .optional()
          .describe('What the tool does (sent to the model)'),
        parameters: z
          .record(z.unknown())
          .optional()
          .describe('JSON Schema for tool input (required for http/client)'),
        execute: z
          .record(z.unknown())
          .optional()
          .describe(
            'Execution config with url and headers (required for http)'
          ),
        mcp: z
          .record(z.unknown())
          .optional()
          .describe(
            'MCP server config with url and headers (required for mcp)'
          ),
        actions: z
          .array(z.string())
          .optional()
          .describe('SOAT platform actions to expose (required for soat)'),
      },
    },
    async ({
      projectId,
      name,
      type,
      description,
      parameters,
      execute,
      mcp,
      actions,
    }) => {
      const data = await apiCall('POST', '/agents/tools', {
        body: {
          projectId,
          name,
          type,
          description,
          parameters,
          execute,
          mcp,
          actions,
        },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'list-agent-tools',
    {
      description: 'List all agent tools in a project.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Public ID of the project to filter by'),
      },
    },
    async ({ projectId }) => {
      const query = projectId
        ? `?projectId=${encodeURIComponent(projectId)}`
        : '';
      const data = await apiCall('GET', `/agents/tools${query}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'get-agent-tool',
    {
      description: 'Get an agent tool by ID.',
      inputSchema: {
        toolId: z.string().describe('Public ID of the agent tool'),
      },
    },
    async ({ toolId }) => {
      const data = await apiCall('GET', `/agents/tools/${toolId}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'update-agent-tool',
    {
      description: 'Update an existing agent tool.',
      inputSchema: {
        toolId: z.string().describe('Public ID of the agent tool to update'),
        name: z.string().optional().describe('New tool name'),
        type: z.string().optional().describe('New tool type'),
        description: z.string().optional().describe('New description'),
        parameters: z
          .record(z.unknown())
          .optional()
          .describe('New JSON Schema for tool input'),
        execute: z
          .record(z.unknown())
          .optional()
          .describe('New execution config'),
        mcp: z.record(z.unknown()).optional().describe('New MCP server config'),
        actions: z
          .array(z.string())
          .optional()
          .describe('New SOAT actions list'),
      },
    },
    async ({
      toolId,
      name,
      type,
      description,
      parameters,
      execute,
      mcp,
      actions,
    }) => {
      const data = await apiCall('PUT', `/agents/tools/${toolId}`, {
        body: { name, type, description, parameters, execute, mcp, actions },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'delete-agent-tool',
    {
      description: 'Delete an agent tool by ID.',
      inputSchema: {
        toolId: z.string().describe('Public ID of the agent tool to delete'),
      },
    },
    async ({ toolId }) => {
      await apiCall('DELETE', `/agents/tools/${toolId}`);
      return {
        content: [{ type: 'text' as const, text: 'Agent tool deleted' }],
      };
    }
  );

  // ── Agents CRUD ──────────────────────────────────────────────────────────

  server.registerTool(
    'create-agent',
    {
      description: 'Create a new agent bound to an AI provider.',
      inputSchema: {
        projectId: z.string().optional().describe('Public ID of the project'),
        aiProviderId: z
          .string()
          .describe('Public ID of the AI provider to use'),
        name: z.string().optional().describe('Display name'),
        instructions: z
          .string()
          .optional()
          .describe('System instructions guiding agent behavior'),
        model: z
          .string()
          .optional()
          .describe('Model identifier (falls back to AI provider default)'),
        toolIds: z
          .array(z.string())
          .optional()
          .describe('IDs of agent tools to attach'),
        maxSteps: z
          .number()
          .optional()
          .describe('Maximum reasoning steps (default: 20)'),
        temperature: z.number().optional().describe('Sampling temperature'),
      },
    },
    async ({
      projectId,
      aiProviderId,
      name,
      instructions,
      model,
      toolIds,
      maxSteps,
      temperature,
    }) => {
      const data = await apiCall('POST', '/agents', {
        body: {
          projectId,
          aiProviderId,
          name,
          instructions,
          model,
          toolIds,
          maxSteps,
          temperature,
        },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'list-agents',
    {
      description: 'List all agents in a project.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Public ID of the project to filter by'),
      },
    },
    async ({ projectId }) => {
      const query = projectId
        ? `?projectId=${encodeURIComponent(projectId)}`
        : '';
      const data = await apiCall('GET', `/agents${query}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'get-agent',
    {
      description: 'Get an agent by ID.',
      inputSchema: {
        agentId: z.string().describe('Public ID of the agent'),
      },
    },
    async ({ agentId }) => {
      const data = await apiCall('GET', `/agents/${agentId}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'update-agent',
    {
      description: 'Update an existing agent.',
      inputSchema: {
        agentId: z.string().describe('Public ID of the agent to update'),
        aiProviderId: z.string().optional().describe('New AI provider ID'),
        name: z.string().optional().describe('New display name'),
        instructions: z.string().optional().describe('New instructions'),
        model: z.string().optional().describe('New model identifier'),
        toolIds: z.array(z.string()).optional().describe('New tool IDs'),
        maxSteps: z.number().optional().describe('New max steps'),
        temperature: z.number().optional().describe('New temperature'),
      },
    },
    async ({
      agentId,
      aiProviderId,
      name,
      instructions,
      model,
      toolIds,
      maxSteps,
      temperature,
    }) => {
      const data = await apiCall('PUT', `/agents/${agentId}`, {
        body: {
          aiProviderId,
          name,
          instructions,
          model,
          toolIds,
          maxSteps,
          temperature,
        },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'delete-agent',
    {
      description: 'Delete an agent by ID.',
      inputSchema: {
        agentId: z.string().describe('Public ID of the agent to delete'),
      },
    },
    async ({ agentId }) => {
      await apiCall('DELETE', `/agents/${agentId}`);
      return { content: [{ type: 'text' as const, text: 'Agent deleted' }] };
    }
  );

  // ── Generation ───────────────────────────────────────────────────────────

  server.registerTool(
    'create-agent-generation',
    {
      description:
        'Run a generation on an agent. Sends messages and runs the AI loop. ' +
        'Client tools may pause the generation with requires_action.',
      inputSchema: {
        agentId: z.string().describe('Public ID of the agent'),
        messages: z
          .array(
            z.object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string(),
            })
          )
          .describe('Ordered list of messages to send'),
        traceId: z
          .string()
          .optional()
          .describe('Optional trace ID to group generations'),
      },
    },
    async ({ agentId, messages, traceId }) => {
      const data = await apiCall('POST', `/agents/${agentId}/generate`, {
        body: { messages, traceId },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'submit-agent-tool-outputs',
    {
      description: 'Submit tool outputs to resume a paused agent generation.',
      inputSchema: {
        agentId: z.string().describe('Public ID of the agent'),
        generationId: z.string().describe('Public ID of the paused generation'),
        toolOutputs: z
          .array(
            z.object({
              toolCallId: z
                .string()
                .describe('ID of the tool call to respond to'),
              output: z.unknown().describe('Result of the tool execution'),
            })
          )
          .describe('Tool outputs for each pending tool call'),
      },
    },
    async ({ agentId, generationId, toolOutputs }) => {
      const data = await apiCall(
        'POST',
        `/agents/${agentId}/generate/${generationId}/tool-outputs`,
        { body: { toolOutputs } }
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  // ── Traces ───────────────────────────────────────────────────────────────

  server.registerTool(
    'list-agent-traces',
    {
      description: 'List agent traces in a project.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Public ID of the project to filter by'),
      },
    },
    async ({ projectId }) => {
      const query = projectId
        ? `?projectId=${encodeURIComponent(projectId)}`
        : '';
      const data = await apiCall('GET', `/agents/traces${query}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );

  server.registerTool(
    'get-agent-trace',
    {
      description: 'Get an agent trace by ID.',
      inputSchema: {
        traceId: z.string().describe('Public ID of the trace'),
      },
    },
    async ({ traceId }) => {
      const data = await apiCall('GET', `/agents/traces/${traceId}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    }
  );
};

export { registerTools };
