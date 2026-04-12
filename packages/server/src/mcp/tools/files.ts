import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-files',
    {
      description: 'List files. Optionally filter by projectId.',
      inputSchema: {
        projectId: z.string().optional().describe('Project ID to filter by'),
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
    async ({ projectId, limit, offset }) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiCall('GET', `/files${qs}`);
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
        mimeType: z
          .string()
          .optional()
          .describe('Alias for contentType (MIME type, e.g. text/plain)'),
        metadata: z
          .string()
          .optional()
          .describe('Additional metadata as a JSON string'),
      },
    },
    async ({
      projectId,
      content,
      filename,
      contentType,
      mimeType,
      metadata,
    }) => {
      const data = await apiCall('POST', '/files/upload/base64', {
        body: {
          projectId,
          content,
          filename,
          contentType: contentType || mimeType,
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
      const data = await apiCall('GET', `/files/${id}/download/base64`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update-file-metadata',
    {
      description: 'Update the metadata and/or filename of a file',
      inputSchema: {
        id: z.string().describe('File ID'),
        metadata: z
          .string()
          .optional()
          .describe('New metadata as a JSON string'),
        filename: z.string().optional().describe('New filename'),
      },
    },
    async ({ id, metadata, filename }) => {
      const data = await apiCall('PATCH', `/files/${id}/metadata`, {
        body: { metadata, filename },
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
      try {
        await apiCall('DELETE', `/files/${id}`);
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
};

export { registerTools };
