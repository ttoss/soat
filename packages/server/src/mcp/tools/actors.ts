import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-actors',
    {
      description:
        'List actors. If projectId is omitted, returns all actors accessible to the caller. Optionally filter by externalId (e.g. WhatsApp phone number).',
      inputSchema: {
        projectId: z.string().optional().describe('Project ID (optional)'),
        externalId: z
          .string()
          .optional()
          .describe('External ID to filter by (e.g. WhatsApp phone number)'),
      },
    },
    async ({ projectId, externalId }) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (externalId) params.set('externalId', externalId);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiCall('GET', `/actors${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-actor',
    {
      description: 'Get an actor by ID',
      inputSchema: {
        id: z.string().describe('Actor ID'),
      },
    },
    async ({ id }) => {
      try {
        const data = await apiCall('GET', `/actors/${id}`);
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
    'create-actor',
    {
      description:
        'Create a new actor. API keys infer the project automatically; JWT callers must supply projectId.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(
            'Project ID (required for JWT auth, optional for API keys)'
          ),
        name: z.string().describe('Actor name'),
        type: z
          .string()
          .optional()
          .describe("Optional actor type (e.g. 'customer', 'agent')"),
        externalId: z
          .string()
          .optional()
          .describe(
            'Optional external identifier (e.g. WhatsApp phone number). Must be unique within the project.'
          ),
      },
    },
    async ({ projectId, name, type, externalId }) => {
      const data = await apiCall('POST', '/actors', {
        body: { projectId, name, type, externalId },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete-actor',
    {
      description: 'Delete an actor by ID',
      inputSchema: {
        id: z.string().describe('Actor ID'),
      },
    },
    async ({ id }) => {
      try {
        await apiCall('DELETE', `/actors/${id}`);
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
    'update-actor',
    {
      description: 'Update an actor by ID',
      inputSchema: {
        id: z.string().describe('Actor ID'),
        name: z.string().optional().describe('New name'),
        type: z.string().optional().describe('New type'),
        externalId: z.string().optional().describe('New external ID'),
      },
    },
    async ({ id, name, type, externalId }) => {
      const data = await apiCall('PATCH', `/actors/${id}`, {
        body: { name, type, externalId },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );
};

export { registerTools };
