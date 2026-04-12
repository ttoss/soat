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
      try {
        const data = await apiCall('GET', `/documents/${id}`);
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
        title: z.string().optional().describe('Optional document title'),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe('Arbitrary key-value metadata'),
        tags: z.array(z.string()).optional().describe('Optional list of tags'),
      },
    },
    async ({ projectId, content, filename, title, metadata, tags }) => {
      const data = await apiCall('POST', '/documents', {
        body: { projectId, content, filename, title, metadata, tags },
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
        tags: z
          .array(z.string())
          .optional()
          .describe('Filter to documents with any of these tags'),
      },
    },
    async ({ projectId, query, limit, threshold, tags }) => {
      const data = await apiCall('POST', '/documents/search', {
        body: { projectId, query, limit, threshold, tags },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update-document',
    {
      description:
        'Update a document by ID. Can update content (re-embeds), title, metadata, or tags.',
      inputSchema: {
        id: z.string().describe('Document ID'),
        content: z
          .string()
          .optional()
          .describe('New text content (re-computes the embedding)'),
        title: z.string().optional().describe('New title'),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe('New metadata object'),
        tags: z.array(z.string()).optional().describe('New list of tags'),
      },
    },
    async ({ id, content, title, metadata, tags }) => {
      try {
        const data = await apiCall('PATCH', `/documents/${id}`, {
          body: { content, title, metadata, tags },
        });
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
};

export { registerTools };
