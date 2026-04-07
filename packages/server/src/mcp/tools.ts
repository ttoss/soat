import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-files',
    {
      description: 'List all files',
      inputSchema: {},
    },
    async () => {
      const data = await apiCall('GET', '/files');
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-file',
    {
      description: 'Get a file by ID',
      inputSchema: {
        id: z.string().describe('File ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('GET', `/files/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'create-file',
    {
      description: 'Create a new file record',
      inputSchema: {
        storageType: z
          .enum(['local', 's3', 'gcs'])
          .describe('Storage backend type'),
        storagePath: z.string().describe('Path in the storage backend'),
        filename: z.string().optional().describe('Original filename'),
        contentType: z.string().optional().describe('MIME content type'),
        size: z.number().optional().describe('File size in bytes'),
        metadata: z.string().optional().describe('Additional metadata'),
      },
    },
    async (body) => {
      const data = await apiCall('POST', '/files', { body });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete-file',
    {
      description: 'Delete a file by ID',
      inputSchema: {
        id: z.string().describe('File ID'),
      },
    },
    async ({ id }) => {
      await apiCall('DELETE', `/files/${id}`);
      return {
        content: [{ type: 'text', text: `File ${id} deleted successfully` }],
      };
    }
  );
};

export { registerTools };
