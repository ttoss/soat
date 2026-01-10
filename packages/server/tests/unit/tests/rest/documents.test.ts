import {
  createDocument,
  deleteDocument,
  type DocumentRecord,
  getDocument,
  listDocuments,
  searchDocumentsBySimilarity,
  updateDocument,
} from '@soat/documents-core';
import { getConfigFromEnv } from '@soat/embeddings-core';
import { app } from 'src/app';
import request from 'supertest';

describe('Documents API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getConfigFromEnv).mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.mocked(getConfigFromEnv).mockReturnValue(undefined as any);
  });

  describe('GET /api/v1/documents/', () => {
    test('should list documents successfully', async () => {
      const mockDocuments = [
        {
          id: 'doc-1',
          title: 'Test Document 1',
          fileId: 'file-1',
          embeddingModel: 'test-model',
          embeddingProvider: 'test-provider',
          metadata: {},
          createdAt: new Date('2026-01-09T16:27:02.008Z'),
          updatedAt: new Date('2026-01-09T16:27:02.008Z'),
        },
      ];

      jest
        .mocked(listDocuments)
        .mockResolvedValue(mockDocuments as DocumentRecord[]);

      const response = await request(app.callback())
        .get('/api/v1/documents/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        documents: [
          {
            id: 'doc-1',
            title: 'Test Document 1',
            fileId: 'file-1',
            embeddingModel: 'test-model',
            embeddingProvider: 'test-provider',
            metadata: {},
            createdAt: '2026-01-09T16:27:02.008Z',
            updatedAt: '2026-01-09T16:27:02.008Z',
          },
        ],
      });
      expect(listDocuments).toHaveBeenCalled();
    });

    test('should handle error when listing documents', async () => {
      jest.mocked(listDocuments).mockRejectedValue(new Error('Database error'));

      const response = await request(app.callback())
        .get('/api/v1/documents/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Database error',
      });
    });
  });

  describe('POST /api/v1/documents/', () => {
    test('should create document successfully', async () => {
      const mockDocument = {
        id: 'doc-1',
        title: 'Test Document',
        fileId: 'file-1',
        content: Buffer.from('Test content'),
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: 'test-model',
        embeddingProvider: 'test-provider',
        metadata: { key: 'value' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.mocked(createDocument).mockResolvedValue(mockDocument);

      const response = await request(app.callback())
        .post('/api/v1/documents/')
        .send({
          content: 'Test content',
          title: 'Test Document',
          metadata: { key: 'value' },
          generateEmbedding: true,
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        success: true,
        document: {
          id: 'doc-1',
          title: 'Test Document',
          fileId: 'file-1',
          embeddingModel: 'test-model',
          embeddingProvider: 'test-provider',
          hasEmbedding: true,
          metadata: { key: 'value' },
          createdAt: mockDocument.createdAt.toISOString(),
          updatedAt: mockDocument.updatedAt.toISOString(),
        },
      });
      expect(createDocument).toHaveBeenCalledWith({
        storageConfig: { type: 'local', local: { path: '/tmp/documents' } },
        embeddingConfig: undefined, // Assuming no env config in tests
        content: 'Test content',
        options: {
          title: 'Test Document',
          metadata: { key: 'value' },
          generateEmbedding: true,
        },
      });
    });

    test('should return 400 if content is missing', async () => {
      const response = await request(app.callback())
        .post('/api/v1/documents/')
        .send({
          title: 'Test Document',
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'Content is required',
      });
    });

    test('should handle error when creating document', async () => {
      jest
        .mocked(createDocument)
        .mockRejectedValue(new Error('Creation error'));

      const response = await request(app.callback())
        .post('/api/v1/documents/')
        .send({
          content: 'Test content',
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Creation error',
      });
    });
  });

  describe('GET /api/v1/documents/search', () => {
    test('should search documents successfully', async () => {
      const mockDocuments = [
        {
          id: 'doc-1',
          title: 'Test Document',
          fileId: 'file-1',
          content: Buffer.from('Test content'),
          embeddingModel: 'test-model',
          embeddingProvider: 'test-provider',
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      jest.mocked(getConfigFromEnv).mockReturnValue({
        provider: 'ollama',
        ollama: { model: 'test', host: 'localhost' },
      });
      jest.mocked(searchDocumentsBySimilarity).mockResolvedValue(mockDocuments);

      const response = await request(app.callback())
        .get('/api/v1/documents/search?query=test')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        documents: [
          {
            id: 'doc-1',
            title: 'Test Document',
            fileId: 'file-1',
            content: 'Test content',
            embeddingModel: 'test-model',
            embeddingProvider: 'test-provider',
            metadata: {},
            createdAt: mockDocuments[0].createdAt.toISOString(),
            updatedAt: mockDocuments[0].updatedAt.toISOString(),
          },
        ],
      });
      expect(searchDocumentsBySimilarity).toHaveBeenCalledWith({
        storageConfig: { type: 'local', local: { path: '/tmp/documents' } },
        embeddingConfig: {
          provider: 'ollama',
          ollama: { model: 'test', host: 'localhost' },
        },
        query: 'test',
        options: {},
      });
    });

    test('should return 400 if query is missing', async () => {
      const response = await request(app.callback())
        .get('/api/v1/documents/search')
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'Query is required',
      });
    });

    test('should handle error when searching documents', async () => {
      jest.mocked(getConfigFromEnv).mockReturnValue({
        provider: 'ollama',
        ollama: { model: 'test', host: 'localhost' },
      });
      jest
        .mocked(searchDocumentsBySimilarity)
        .mockRejectedValue(new Error('Search error'));

      const response = await request(app.callback())
        .get('/api/v1/documents/search?query=test')
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Search error',
      });
    });
  });

  describe('GET /api/v1/documents/:id', () => {
    test('should get document by id successfully', async () => {
      const mockDocument = {
        id: 'doc-1',
        title: 'Test Document',
        fileId: 'file-1',
        content: Buffer.from('Test content'),
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: 'test-model',
        embeddingProvider: 'test-provider',
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.mocked(getDocument).mockResolvedValue(mockDocument);

      const response = await request(app.callback())
        .get('/api/v1/documents/doc-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        document: {
          id: 'doc-1',
          title: 'Test Document',
          fileId: 'file-1',
          content: 'Test content',
          embeddingModel: 'test-model',
          embeddingProvider: 'test-provider',
          hasEmbedding: true,
          metadata: {},
          createdAt: mockDocument.createdAt.toISOString(),
          updatedAt: mockDocument.updatedAt.toISOString(),
        },
      });
      expect(getDocument).toHaveBeenCalledWith({
        storageConfig: { type: 'local', local: { path: '/tmp/documents' } },
        id: 'doc-1',
      });
    });

    test('should return 404 if document not found', async () => {
      jest.mocked(getDocument).mockResolvedValue(null);

      const response = await request(app.callback())
        .get('/api/v1/documents/doc-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        error: 'Document not found',
      });
    });

    test('should handle error when getting document', async () => {
      jest.mocked(getDocument).mockRejectedValue(new Error('Get error'));

      const response = await request(app.callback())
        .get('/api/v1/documents/doc-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Get error',
      });
    });
  });

  describe('PUT /api/v1/documents/:id', () => {
    test('should update document successfully', async () => {
      const mockDocument = {
        id: 'doc-1',
        title: 'Updated Document',
        fileId: 'file-1',
        content: Buffer.from('Updated content'),
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: 'test-model',
        embeddingProvider: 'test-provider',
        metadata: { updated: true },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.mocked(updateDocument).mockResolvedValue(mockDocument);

      const response = await request(app.callback())
        .put('/api/v1/documents/doc-1')
        .send({
          content: 'Updated content',
          title: 'Updated Document',
          metadata: { updated: true },
          regenerateEmbedding: true,
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        document: {
          id: 'doc-1',
          title: 'Updated Document',
          fileId: 'file-1',
          content: 'Updated content',
          embeddingModel: 'test-model',
          embeddingProvider: 'test-provider',
          hasEmbedding: true,
          metadata: { updated: true },
          createdAt: mockDocument.createdAt.toISOString(),
          updatedAt: mockDocument.updatedAt.toISOString(),
        },
      });
      expect(updateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          storageConfig: { type: 'local', local: { path: '/tmp/documents' } },
          id: 'doc-1',
          content: 'Updated content',
          title: 'Updated Document',
          metadata: { updated: true },
          regenerateEmbedding: true,
        })
      );
    });

    test('should return 404 if document not found', async () => {
      jest.mocked(updateDocument).mockResolvedValue(null);

      const response = await request(app.callback())
        .put('/api/v1/documents/doc-1')
        .send({
          content: 'Updated content',
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        error: 'Document not found',
      });
    });

    test('should handle error when updating document', async () => {
      jest.mocked(updateDocument).mockRejectedValue(new Error('Update error'));

      const response = await request(app.callback())
        .put('/api/v1/documents/doc-1')
        .send({
          content: 'Updated content',
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Update error',
      });
    });
  });

  describe('DELETE /api/v1/documents/:id', () => {
    test('should delete document successfully', async () => {
      jest.mocked(deleteDocument).mockResolvedValue(true);

      const response = await request(app.callback())
        .delete('/api/v1/documents/doc-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
      });
      expect(deleteDocument).toHaveBeenCalledWith({
        storageConfig: { type: 'local', local: { path: '/tmp/documents' } },
        id: 'doc-1',
      });
    });

    test('should return 404 if document not found', async () => {
      jest.mocked(deleteDocument).mockResolvedValue(false);

      const response = await request(app.callback())
        .delete('/api/v1/documents/doc-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        error: 'Document not found',
      });
    });

    test('should handle error when deleting document', async () => {
      jest.mocked(deleteDocument).mockRejectedValue(new Error('Delete error'));

      const response = await request(app.callback())
        .delete('/api/v1/documents/doc-1')
        .set('Accept', 'application/json');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Delete error',
      });
    });
  });
});
