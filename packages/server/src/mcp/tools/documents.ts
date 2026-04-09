import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-documents',
    {
      description: 'List all documents in a project',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
      },
    },
    async ({ projectId }) => {
      const data = await apiCall(
        'GET',
        `/documents?projectId=${encodeURIComponent(projectId)}`
      );
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
        'Create a new text document with an embedding vector for semantic search',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
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
      await apiCall('DELETE', `/documents/${id}`);
      return { content: [{ type: 'text', text: 'Document deleted' }] };
    }
  );

  server.registerTool(
    'search-documents',
    {
      description:
        'Perform semantic search over documents in a project using cosine similarity',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        query: z.string().describe('Natural language search query'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of results (default: 10)'),
      },
    },
    async ({ projectId, query, limit }) => {
      const data = await apiCall('POST', '/documents/search', {
        body: { projectId, query, limit },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );
};

export { registerTools };
