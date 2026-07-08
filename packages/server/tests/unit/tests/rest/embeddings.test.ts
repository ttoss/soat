import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Embeddings', () => {
  let adminToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');
  });

  describe('POST /api/v1/embeddings', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/embeddings')
        .send({ input: 'hello world' });

      expect(response.status).toBe(401);
    });

    test('missing input and inputs returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/embeddings')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('empty inputs array returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/embeddings')
        .send({ inputs: [] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('single input returns embedding vector', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/embeddings')
        .send({ input: 'The quick brown fox.' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.embedding)).toBe(true);
      expect(response.body.embedding.length).toBe(1024);
      expect(response.body.embeddings).toBeUndefined();
    });

    test('batch inputs returns embeddings array', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/embeddings')
        .send({
          inputs: [
            'The quick brown fox.',
            'Pack my box with five dozen liquor jugs.',
          ],
        });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.embeddings)).toBe(true);
      expect(response.body.embeddings).toHaveLength(2);
      expect(Array.isArray(response.body.embeddings[0])).toBe(true);
      expect(response.body.embeddings[0]).toHaveLength(1024);
      expect(response.body.embedding).toBeUndefined();
    });

    test('returns 503 when embedding provider is not configured', async () => {
      const prevProvider = process.env.EMBEDDING_PROVIDER;
      delete process.env.EMBEDDING_PROVIDER;

      try {
        const response = await authenticatedTestClient(adminToken)
          .post('/api/v1/embeddings')
          .send({ input: 'hello world' });

        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe('EMBEDDING_NOT_CONFIGURED');
      } finally {
        process.env.EMBEDDING_PROVIDER = prevProvider;
      }
    });

    test('both input and inputs returns both fields', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/embeddings')
        .send({
          input: 'Hello world.',
          inputs: ['Foo', 'Bar'],
        });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.embedding)).toBe(true);
      expect(Array.isArray(response.body.embeddings)).toBe(true);
      expect(response.body.embeddings).toHaveLength(2);
    });
  });
});
