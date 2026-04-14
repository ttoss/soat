import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
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
