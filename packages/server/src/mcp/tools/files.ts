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
    'upload-file',
    {
      description:
        'Upload a file to the server. The file content must be provided as a base64-encoded string.',
      inputSchema: {
        projectId: z.string().describe('Project ID to associate the file with'),
        content: z.string().describe('Base64-encoded file content'),
        filename: z.string().optional().describe('Original filename'),
        contentType: z
          .string()
          .optional()
          .describe('MIME content type, e.g. text/plain'),
        metadata: z
          .string()
          .optional()
          .describe('Additional metadata as a JSON string'),
      },
    },
    async ({ projectId, content, filename, contentType, metadata }) => {
      const buffer = Buffer.from(content, 'base64');
      const data = await apiCall('POST', '/files/upload', {
        body: {
          projectId,
          fileBuffer: buffer.toString('base64'),
          filename,
          contentType,
          metadata,
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'download-file',
    {
      description: 'Download a file by ID and return its content as base64',
      inputSchema: {
        id: z.string().describe('File ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('GET', `/files/${id}/download`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update-file-metadata',
    {
      description: 'Update the metadata of a file',
      inputSchema: {
        id: z.string().describe('File ID'),
        metadata: z.string().describe('New metadata as a JSON string'),
      },
    },
    async ({ id, metadata }) => {
      const data = await apiCall('PATCH', `/files/${id}/metadata`, {
        body: { metadata },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'create-file',
    {
      description: 'Create a file metadata record without uploading content',
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
