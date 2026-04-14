import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const chatMessageInputSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().optional().describe('Text content of the message'),
  documentId: z
    .string()
    .optional()
    .describe('Public ID of a document to use as the message content'),
});

const registerTools = (server: McpServer) => {
  server.registerTool(
    'create-chat',
    {
      description: 'Create a new chat bound to an AI provider.',
      inputSchema: {
        aiProviderId: z
          .string()
          .describe('Public ID of the AI provider to use'),
        projectId: z
          .string()
          .optional()
          .describe('Public ID of the project this chat belongs to'),
        name: z.string().optional().describe('Optional human-readable name'),
        systemMessage: z
          .string()
          .optional()
          .describe('Optional system message applied to all completions'),
        model: z
          .string()
          .optional()
          .describe('Optional default model override'),
      },
    },
    async ({ aiProviderId, projectId, name, systemMessage, model }) => {
      const data = await apiCall('POST', '/chats', {
        body: { aiProviderId, projectId, name, systemMessage, model },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'list-chats',
    {
      description: 'List all chats in a project.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Public ID of the project to list chats for'),
      },
    },
    async ({ projectId }) => {
      const query = projectId
        ? `?projectId=${encodeURIComponent(projectId)}`
        : '';
      const data = await apiCall('GET', `/chats${query}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-chat',
    {
      description: 'Get a chat by ID.',
      inputSchema: {
        chatId: z.string().describe('Public ID of the chat'),
      },
    },
    async ({ chatId }) => {
      const data = await apiCall('GET', `/chats/${chatId}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete-chat',
    {
      description: 'Delete a chat by ID.',
      inputSchema: {
        chatId: z.string().describe('Public ID of the chat to delete'),
      },
    },
    async ({ chatId }) => {
      await apiCall('DELETE', `/chats/${chatId}`);
      return { content: [{ type: 'text', text: 'Chat deleted' }] };
    }
  );

  server.registerTool(
    'create-chat-completion-for-chat',
    {
      description:
        'Run a completion using the AI provider and settings stored in a chat. ' +
        'Messages may include a documentId instead of content.',
      inputSchema: {
        chatId: z.string().describe('Public ID of the chat'),
        messages: z
          .array(chatMessageInputSchema)
          .describe('Ordered list of chat messages'),
        model: z
          .string()
          .optional()
          .describe("Override the chat's default model for this call"),
      },
    },
    async ({ chatId, messages, model }) => {
      const data = await apiCall('POST', `/chats/${chatId}/completions`, {
        messages,
        model,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'create-chat-completion',
    {
      description:
        'Send a list of messages to an AI provider and receive a completion. ' +
        'Falls back to Ollama when aiProviderId is omitted.',
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string(),
            })
          )
          .describe('Ordered list of chat messages'),
        aiProviderId: z
          .string()
          .optional()
          .describe(
            'Public ID of the AI provider to use. Omit to use the Ollama fallback.'
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model identifier. Overrides the provider's defaultModel when specified."
          ),
      },
    },
    async ({ messages, aiProviderId, model }) => {
      const data = await apiCall('POST', '/chats/completions', {
        messages,
        aiProviderId,
        model,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );
};

export { registerTools };
