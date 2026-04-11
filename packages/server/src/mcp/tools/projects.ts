import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-projects',
    {
      description: 'List all projects accessible to the current user',
      inputSchema: {},
    },
    async () => {
      const data = await apiCall('GET', '/projects');
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-project',
    {
      description: 'Get a project by ID',
      inputSchema: {
        id: z.string().describe('Project ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('GET', `/projects/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );
};

export { registerTools };
