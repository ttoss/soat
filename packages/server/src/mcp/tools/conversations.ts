import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-conversations',
    {
      description:
        'List conversations. If projectId is omitted, returns all conversations accessible to the caller. Optionally filter by actorId.',
      inputSchema: {
        projectId: z.string().optional().describe('Project ID (optional)'),
        actorId: z
          .string()
          .optional()
          .describe('Actor ID to filter conversations by'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default 50)'),
        offset: z
          .number()
          .optional()
          .describe('Number of results to skip (default 0)'),
      },
    },
    async ({ projectId, actorId, limit, offset }) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (actorId) params.set('actorId', actorId);
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiCall('GET', `/conversations${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-conversation',
    {
      description: 'Get a conversation by ID',
      inputSchema: {
        id: z.string().describe('Conversation ID'),
      },
    },
    async ({ id }) => {
      try {
        const data = await apiCall('GET', `/conversations/${id}`);
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'not_found',
                message: String(error),
              }),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    'create-conversation',
    {
      description:
        'Create a new conversation. API keys infer the project automatically; JWT callers must supply projectId.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(
            'Project ID (required for JWT auth, optional for API keys)'
          ),
        status: z
          .string()
          .optional()
          .describe(
            "Initial status, either 'open' or 'closed'. Defaults to 'open'."
          ),
      },
    },
    async ({ projectId, status }) => {
      const data = await apiCall('POST', '/conversations', {
        body: { projectId, status },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update-conversation',
    {
      description: "Update a conversation's status",
      inputSchema: {
        id: z.string().describe('Conversation ID'),
        status: z.string().describe("New status, either 'open' or 'closed'"),
      },
    },
    async ({ id, status }) => {
      const data = await apiCall('PATCH', `/conversations/${id}`, {
        body: { status },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete-conversation',
    {
      description: 'Delete a conversation by ID',
      inputSchema: {
        id: z.string().describe('Conversation ID'),
      },
    },
    async ({ id }) => {
      try {
        await apiCall('DELETE', `/conversations/${id}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id, deleted: true }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id,
                deleted: false,
                error: String(error),
              }),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    'list-conversation-messages',
    {
      description:
        'List all messages (documents) in a conversation, ordered by position',
      inputSchema: {
        id: z.string().describe('Conversation ID'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default 50)'),
        offset: z
          .number()
          .optional()
          .describe('Number of results to skip (default 0)'),
      },
    },
    async ({ id, limit, offset }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiCall('GET', `/conversations/${id}/messages${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'add-conversation-message',
    {
      description:
        'Add a message to a conversation. The message content is saved as a document internally. If position is omitted, the message is appended at the end.',
      inputSchema: {
        id: z.string().describe('Conversation ID'),
        message: z.string().describe('Message text content to send'),
        actorId: z.string().describe('Actor ID who is sending this message'),
        position: z
          .number()
          .optional()
          .describe(
            'Zero-based position in the conversation. Defaults to MAX+1 (append).'
          ),
      },
    },
    async ({ id, message, actorId, position }) => {
      const data = await apiCall('POST', `/conversations/${id}/messages`, {
        body: { message, actorId, position },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'list-conversation-actors',
    {
      description:
        'List all distinct actors who have sent at least one message in a conversation',
      inputSchema: {
        id: z.string().describe('Conversation ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('GET', `/conversations/${id}/actors`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'remove-conversation-message',
    {
      description: 'Remove a document from a conversation',
      inputSchema: {
        id: z.string().describe('Conversation ID'),
        documentId: z.string().describe('Document ID to remove'),
      },
    },
    async ({ id, documentId }) => {
      try {
        await apiCall('DELETE', `/conversations/${id}/messages/${documentId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                conversationId: id,
                documentId,
                deleted: true,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                conversationId: id,
                documentId,
                deleted: false,
                error: String(error),
              }),
            },
          ],
        };
      }
    }
  );
};

export { registerTools };
