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
import { Router } from '@ttoss/http-server';

import type { Context } from '../../Context';

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

const documentsRouter = new Router<unknown, Context>();

documentsRouter.get('/', async (ctx: Context) => {
  try {
    const documents = await listDocuments();
    ctx.status = 200;
    ctx.body = { success: true, documents };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

documentsRouter.post('/', async (ctx: Context) => {
  try {
    const { content, title, metadata, generateEmbedding } = ctx.request.body;
    if (!content) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'Content is required' };
      return;
    }

    const embeddingConfig = getEmbeddingConfig();

    const document = await createDocument({
      storageConfig: defaultStorageConfig,
      embeddingConfig,
      content,
      options: {
        title,
        metadata,
        generateEmbedding,
      },
    });

    ctx.status = 201;
    ctx.body = {
      success: true,
      document: {
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
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

documentsRouter.get('/search', async (ctx: Context) => {
  try {
    const { query, limit, threshold } = ctx.query;
    if (!query || typeof query !== 'string') {
      ctx.status = 400;
      ctx.body = { success: false, error: 'Query is required' };
      return;
    }

    const embeddingConfig = getEmbeddingConfig();
    if (!embeddingConfig) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error:
          'Embedding configuration is required for search. Set EMBEDDINGS_OLLAMA_MODEL or EMBEDDINGS_OPENAI_KEY',
      };
      return;
    }

    const documents = await searchDocumentsBySimilarity({
      storageConfig: defaultStorageConfig,
      embeddingConfig,
      query,
      options: {
        limit: limit ? parseInt(limit as string, 10) : undefined,
        threshold: threshold ? parseFloat(threshold as string) : undefined,
      },
    });

    ctx.status = 200;
    ctx.body = {
      success: true,
      documents: documents.map((doc) => {
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
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

documentsRouter.get('/:id', async (ctx: Context) => {
  try {
    const { id } = ctx.params;
    if (!id) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'ID is required' };
      return;
    }

    const document = await getDocument({
      storageConfig: defaultStorageConfig,
      id,
    });

    if (!document) {
      ctx.status = 404;
      ctx.body = { success: false, error: 'Document not found' };
      return;
    }

    ctx.status = 200;
    ctx.body = {
      success: true,
      document: {
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
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

documentsRouter.put('/:id', async (ctx: Context) => {
  try {
    const { id } = ctx.params;
    if (!id) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'ID is required' };
      return;
    }

    const { content, title, metadata, regenerateEmbedding } = ctx.request.body;
    const embeddingConfig = getEmbeddingConfig();

    const document = await updateDocument({
      storageConfig: defaultStorageConfig,
      embeddingConfig,
      id,
      content,
      title,
      metadata,
      regenerateEmbedding,
    });

    if (!document) {
      ctx.status = 404;
      ctx.body = { success: false, error: 'Document not found' };
      return;
    }

    ctx.status = 200;
    ctx.body = {
      success: true,
      document: {
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
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

documentsRouter.delete('/:id', async (ctx: Context) => {
  try {
    const { id } = ctx.params;
    if (!id) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'ID is required' };
      return;
    }

    const deleted = await deleteDocument({
      storageConfig: defaultStorageConfig,
      id,
    });

    if (!deleted) {
      ctx.status = 404;
      ctx.body = { success: false, error: 'Document not found' };
      return;
    }

    ctx.status = 200;
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

export { documentsRouter };
