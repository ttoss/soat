import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-documents',
    {
      description:
        'List documents. If projectId is omitted, returns all documents accessible to the caller.',
      inputSchema: {
        projectId: z.string().optional().describe('Project ID (optional)'),
      },
    },
    async ({ projectId }) => {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const data = await apiCall('GET', `/documents${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-document',
    {
      description: 'Get a document by ID including its text content',
      inputSchema: {
        id: z.string().describe('Document ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('GET', `/documents/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'create-document',
    {
      description:
        'Create a new text document with an embedding vector for semantic search. API keys infer the project automatically; JWT callers must supply projectId.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(
            'Project ID (required for JWT auth, optional for API keys)'
          ),
        content: z.string().describe('Text content of the document'),
        filename: z.string().optional().describe('Optional filename'),
      },
    },
    async ({ projectId, content, filename }) => {
      const data = await apiCall('POST', '/documents', {
        body: { projectId, content, filename },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete-document',
    {
      description: 'Delete a document and its underlying file',
      inputSchema: {
        id: z.string().describe('Document ID'),
      },
    },
    async ({ id }) => {
      try {
        await apiCall('DELETE', `/documents/${id}`);
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
    'search-documents',
    {
      description:
        'Perform semantic search over documents using cosine similarity. If projectId is omitted, searches across all accessible projects.',
      inputSchema: {
        projectId: z.string().optional().describe('Project ID (optional)'),
        query: z.string().describe('Natural language search query'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results (default: 10)'),
        threshold: z
          .number()
          .optional()
          .describe(
            'Minimum similarity score (0-1). Only results with score >= threshold are returned.'
          ),
      },
    },
    async ({ projectId, query, limit, threshold }) => {
      const data = await apiCall('POST', '/documents/search', {
        body: { projectId, query, limit, threshold },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );
};

export { registerTools };
