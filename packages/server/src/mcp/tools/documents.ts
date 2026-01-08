import {
  createDocument,
  deleteDocument,
  type EmbeddingConfig,
  getDocument,
  listDocuments,
  searchDocumentsBySimilarity,
  type StorageConfig,
  updateDocument,
} from '@soat/documents-core';
import { getConfigFromEnv } from '@soat/embeddings-core';
import { z } from '@ttoss/http-server-mcp';

const defaultStorageConfig: StorageConfig = {
  type: 'local',
  local: {
    path: '/tmp/documents',
  },
};

const getEmbeddingConfig = (): EmbeddingConfig | undefined => {
  try {
    return getConfigFromEnv();
  } catch {
    return undefined;
  }
};

export const listDocumentsTool = {
  name: 'list-documents',
  description: 'List all documents',
  inputSchema: z.object({}),
  handler: async () => {
    try {
      const documents = await listDocuments();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              documents.map((doc) => {
                return {
                  id: doc.id,
                  title: doc.title,
                  fileId: doc.fileId,
                  embeddingModel: doc.embeddingModel,
                  embeddingProvider: doc.embeddingProvider,
                  metadata: doc.metadata,
                  createdAt: doc.createdAt,
                  updatedAt: doc.updatedAt,
                };
              }),
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing documents: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          },
        ],
      };
    }
  },
};

export const createDocumentTool = {
  name: 'create-document',
  description: 'Create a new document',
  inputSchema: z.object({
    content: z.string().describe('The content of the document'),
    title: z
      .string()
      .optional()
      .describe('The title of the document (optional)'),
    metadata: z
      .record(z.any())
      .optional()
      .describe('Additional metadata for the document (optional)'),
    generateEmbedding: z
      .boolean()
      .optional()
      .describe('Whether to generate embeddings for the document (optional)'),
  }),
  handler: async (args: {
    content: string;
    title?: string;
    metadata?: Record<string, unknown>;
    generateEmbedding?: boolean;
  }) => {
    try {
      const embeddingConfig = getEmbeddingConfig();

      const document = await createDocument({
        storageConfig: defaultStorageConfig,
        embeddingConfig,
        content: args.content,
        options: {
          title: args.title,
          metadata: args.metadata,
          generateEmbedding: args.generateEmbedding,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: document.id,
                title: document.title,
                fileId: document.fileId,
                embeddingModel: document.embeddingModel,
                embeddingProvider: document.embeddingProvider,
                hasEmbedding: !!document.embedding,
                metadata: document.metadata,
                createdAt: document.createdAt,
                updatedAt: document.updatedAt,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error creating document: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          },
        ],
      };
    }
  },
};

export const getDocumentTool = {
  name: 'get-document',
  description: 'Get a document by ID',
  inputSchema: z.object({
    id: z.string().describe('The ID of the document to retrieve'),
  }),
  handler: async (args: { id: string }) => {
    try {
      const document = await getDocument({
        storageConfig: defaultStorageConfig,
        id: args.id,
      });

      if (!document) {
        return {
          content: [
            {
              type: 'text',
              text: 'Document not found',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: document.id,
                title: document.title,
                fileId: document.fileId,
                content: document.content?.toString(),
                embeddingModel: document.embeddingModel,
                embeddingProvider: document.embeddingProvider,
                hasEmbedding: !!document.embedding,
                metadata: document.metadata,
                createdAt: document.createdAt,
                updatedAt: document.updatedAt,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting document: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          },
        ],
      };
    }
  },
};

export const updateDocumentTool = {
  name: 'update-document',
  description: 'Update an existing document',
  inputSchema: z.object({
    id: z.string().describe('The ID of the document to update'),
    content: z
      .string()
      .optional()
      .describe('The new content of the document (optional)'),
    title: z
      .string()
      .optional()
      .describe('The new title of the document (optional)'),
    metadata: z
      .record(z.any())
      .optional()
      .describe('The new metadata for the document (optional)'),
    regenerateEmbedding: z
      .boolean()
      .optional()
      .describe('Whether to regenerate embeddings for the document (optional)'),
  }),
  handler: async (args: {
    id: string;
    content?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    regenerateEmbedding?: boolean;
  }) => {
    try {
      const embeddingConfig = getEmbeddingConfig();

      const document = await updateDocument({
        storageConfig: defaultStorageConfig,
        embeddingConfig,
        id: args.id,
        content: args.content,
        title: args.title,
        metadata: args.metadata,
        regenerateEmbedding: args.regenerateEmbedding,
      });

      if (!document) {
        return {
          content: [
            {
              type: 'text',
              text: 'Document not found',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: document.id,
                title: document.title,
                fileId: document.fileId,
                content: document.content?.toString(),
                embeddingModel: document.embeddingModel,
                embeddingProvider: document.embeddingProvider,
                hasEmbedding: !!document.embedding,
                metadata: document.metadata,
                createdAt: document.createdAt,
                updatedAt: document.updatedAt,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error updating document: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          },
        ],
      };
    }
  },
};

export const deleteDocumentTool = {
  name: 'delete-document',
  description: 'Delete a document by ID',
  inputSchema: z.object({
    id: z.string().describe('The ID of the document to delete'),
  }),
  handler: async (args: { id: string }) => {
    try {
      const deleted = await deleteDocument({
        storageConfig: defaultStorageConfig,
        id: args.id,
      });

      if (!deleted) {
        return {
          content: [
            {
              type: 'text',
              text: 'Document not found',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: 'Document deleted successfully',
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error deleting document: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          },
        ],
      };
    }
  },
};

export const searchDocumentsTool = {
  name: 'search-documents',
  description: 'Search documents by similarity using embeddings',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    limit: z
      .number()
      .optional()
      .describe('Maximum number of documents to return (optional)'),
    threshold: z
      .number()
      .optional()
      .describe('Similarity threshold (optional)'),
  }),
  handler: async (args: {
    query: string;
    limit?: number;
    threshold?: number;
  }) => {
    try {
      const embeddingConfig = getEmbeddingConfig();
      if (!embeddingConfig) {
        return {
          content: [
            {
              type: 'text',
              text: 'Embedding configuration is required for search. Set EMBEDDINGS_OLLAMA_MODEL or EMBEDDINGS_OPENAI_KEY',
            },
          ],
        };
      }

      const documents = await searchDocumentsBySimilarity({
        storageConfig: defaultStorageConfig,
        embeddingConfig,
        query: args.query,
        options: {
          limit: args.limit,
          threshold: args.threshold,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              documents.map((doc) => {
                return {
                  id: doc.id,
                  title: doc.title,
                  fileId: doc.fileId,
                  content: doc.content?.toString(),
                  embeddingModel: doc.embeddingModel,
                  embeddingProvider: doc.embeddingProvider,
                  metadata: doc.metadata,
                  createdAt: doc.createdAt,
                  updatedAt: doc.updatedAt,
                };
              }),
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching documents: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
          },
        ],
      };
    }
  },
};
