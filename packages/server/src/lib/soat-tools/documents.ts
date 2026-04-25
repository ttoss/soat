import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-documents',
    description:
      'List documents. If projectId is omitted, returns all documents accessible to the caller.',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set('projectId', String(args.projectId));
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      return qs ? `/documents?${qs}` : '/documents';
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to filter by' },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
        offset: { type: 'number', description: 'Number of results to skip' },
      },
    },
    iamAction: 'documents:ListDocuments',
  },
  {
    name: 'get-document',
    description: 'Get a document by ID',
    method: 'GET',
    path: (args) => {
      return `/documents/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID' },
      },
      required: ['id'],
    },
    iamAction: 'documents:GetDocument',
  },
  {
    name: 'create-document',
    description:
      'Create a new document. Project keys infer the project automatically.',
    method: 'POST',
    path: () => {
      return '/documents';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        content: args.content,
        filename: args.filename,
        title: args.title,
        metadata: args.metadata,
        tags: args.tags,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        content: { type: 'string', description: 'Document content' },
        filename: { type: 'string', description: 'Filename' },
        title: { type: 'string', description: 'Document title' },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata key-value pairs',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for filtering',
        },
      },
      required: ['content'],
    },
    iamAction: 'documents:CreateDocument',
  },
  {
    name: 'delete-document',
    description: 'Delete a document by ID',
    method: 'DELETE',
    path: (args) => {
      return `/documents/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID' },
      },
      required: ['id'],
    },
    iamAction: 'documents:DeleteDocument',
  },
  {
    name: 'search-documents',
    description:
      'Search documents using semantic similarity, path prefixes, or specific IDs. ' +
      'At least one of search, paths, or documentIds must be provided. ' +
      'Returns documents ranked by relevance when search is used.',
    method: 'POST',
    path: () => {
      return '/documents/search';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        search: args.search,
        minScore: args.minScore,
        limit: args.limit,
        paths: args.paths,
        documentIds: args.documentIds,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to search in' },
        search: {
          type: 'string',
          description:
            'Semantic search query. Documents are ranked by embedding similarity.',
        },
        minScore: {
          type: 'number',
          description:
            'Minimum similarity score threshold (0–1). Only applies when search is set.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter to documents whose filename starts with any of these prefixes.',
        },
        documentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to these specific document public IDs.',
        },
      },
    },
    iamAction: 'documents:SearchDocuments',
  },
  {
    name: 'update-document',
    description: 'Update a document by ID',
    method: 'PATCH',
    path: (args) => {
      return `/documents/${args.id}`;
    },
    body: (args) => {
      return {
        content: args.content,
        title: args.title,
        metadata: args.metadata,
        tags: args.tags,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID' },
        content: { type: 'string', description: 'New content' },
        title: { type: 'string', description: 'New title' },
        metadata: {
          type: 'object',
          description: 'New metadata key-value pairs',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags',
        },
      },
      required: ['id'],
    },
    iamAction: 'documents:UpdateDocument',
  },
];
