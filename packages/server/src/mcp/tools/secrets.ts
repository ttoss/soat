import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-secrets',
    {
      description: 'List secrets in a project. Values are never returned.',
      inputSchema: {
        projectId: z.string().optional().describe('Project ID to filter by'),
      },
    },
    async ({ projectId }) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiCall('GET', `/secrets${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-secret',
    {
      description: 'Get a secret by ID. The value is never returned.',
      inputSchema: {
        id: z.string().describe('Secret ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('GET', `/secrets/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'create-secret',
    {
      description:
        'Create a new secret. The value is encrypted at rest and never returned.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(
            'Project ID. Required for JWT auth; omit when using a project key.'
          ),
        name: z.string().describe('Secret name'),
        value: z
          .string()
          .optional()
          .describe('Secret value to encrypt and store'),
      },
    },
    async ({ projectId, name, value }) => {
      const data = await apiCall('POST', '/secrets', {
        body: { projectId, name, value },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update-secret',
    {
      description: 'Update the name or value of a secret.',
      inputSchema: {
        id: z.string().describe('Secret ID'),
        name: z.string().optional().describe('New name'),
        value: z
          .string()
          .optional()
          .describe('New secret value to encrypt and store'),
      },
    },
    async ({ id, name, value }) => {
      const data = await apiCall('PATCH', `/secrets/${id}`, {
        body: { name, value },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete-secret',
    {
      description:
        'Delete a secret. Returns a conflict error if referenced by an AI provider unless force is true.',
      inputSchema: {
        id: z.string().describe('Secret ID'),
        force: z
          .boolean()
          .optional()
          .describe('If true, also delete dependent AI providers'),
      },
    },
    async ({ id, force }) => {
      const params = new URLSearchParams();
      if (force) params.set('force', 'true');
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiCall('DELETE', `/secrets/${id}${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );
};

export { registerTools };
