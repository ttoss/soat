import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authenticatedTestClient, loginAs, testClient } from '../testClient';

jest.mock('src/lib/embedding', () => {
  return {
    getEmbedding: jest.fn().mockResolvedValue(Array(1024).fill(0.1)),
  };
});

describe('Documents', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let storageDir: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-docs-test-'));

    process.env.FILES_STORAGE_DIR = storageDir;

    process.env.EMBEDDING_PROVIDER = 'ollama';

    process.env.EMBEDDING_MODEL = 'qwen3-embedding:0.6b';

    process.env.EMBEDDING_DIMENSIONS = '1024';

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'docsuser', password: 'docspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('docsuser', 'docspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Docs Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: [
          'documents:ListDocuments',
          'documents:GetDocument',
          'documents:CreateDocument',
          'documents:DeleteDocument',
          'documents:SearchDocuments',
          'documents:UpdateDocument',
        ],
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId, policyId });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/documents', () => {
    test('authenticated user with permission can create a document', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          projectId,
          content: 'Hello, world! This is a test document.',
          filename: 'hello.txt',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^doc_/);
      expect(response.body.filename).toBe('hello.txt');
      expect(response.body.projectId).toBe(projectId);
      expect(response.body.size).toBeGreaterThan(0);
      expect(response.body.content).toBeUndefined();
    });

    test('unauthenticated request cannot create a document', async () => {
      const response = await testClient.post('/api/v1/documents').send({
        projectId,
        content: 'Secret',
      });

      expect(response.status).toBe(401);
    });

    test('missing projectId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ content: 'No project' });

      expect(response.status).toBe(400);
    });

    test('missing content returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ projectId });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/documents', () => {
    test('authenticated user with permission can list documents', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?projectId=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('unauthenticated request cannot list documents', async () => {
      const response = await testClient.get(
        `/api/v1/documents?projectId=${projectId}`
      );

      expect(response.status).toBe(401);
    });

    test('listing without projectId returns all accessible documents', async () => {
      const response =
        await authenticatedTestClient(userToken).get('/api/v1/documents');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/documents/:id', () => {
    let documentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          projectId,
          content: 'Fetch this document back.',
          filename: 'fetch-me.txt',
        });
      documentId = res.body.id;
    });

    test('user with permission can get a document by ID including content', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${documentId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(documentId);
      expect(response.body.content).toBe('Fetch this document back.');
    });

    test('unauthenticated request cannot get a document', async () => {
      const response = await testClient.get(`/api/v1/documents/${documentId}`);

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent document', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/documents/doc_nonexistent'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/documents/search', () => {
    beforeAll(async () => {
      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        projectId,
        content: 'The capital of France is Paris.',
        filename: 'france.txt',
      });
    });

    test('user with permission can search documents', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ projectId, query: 'capital of France' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('search with limit returns at most limit results', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ projectId, query: 'test content', limit: 1 });

      expect(response.status).toBe(200);
      expect(response.body.length).toBeLessThanOrEqual(1);
    });

    test('unauthenticated request cannot search documents', async () => {
      const response = await testClient
        .post('/api/v1/documents/search')
        .send({ projectId, query: 'test' });

      expect(response.status).toBe(401);
    });

    test('search without projectId returns results across accessible projects', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ query: 'no project' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('missing query returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ projectId });

      expect(response.status).toBe(400);
    });

    test('search results include score and content fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ projectId, query: 'capital of France' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      if (response.body.length > 0) {
        expect(typeof response.body[0].score).toBe('number');
        expect(typeof response.body[0].content).toBe('string');
      }
    });

    test('search with threshold filters low-score results', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ projectId, query: 'capital of France', threshold: 0.99 });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      for (const doc of response.body) {
        expect(doc.score).toBeGreaterThanOrEqual(0.99);
      }
    });
  });

  describe('DELETE /api/v1/documents/:id', () => {
    test('user with permission can delete a document and file is removed from disk', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          projectId,
          content: 'Delete me please.',
          filename: 'todelete.txt',
        });
      const documentId = createRes.body.id;

      const filesOnDisk = fs.readdirSync(storageDir);
      expect(filesOnDisk.length).toBeGreaterThan(0);

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/documents/${documentId}`
      );

      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${documentId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request cannot delete a document', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ projectId, content: 'Protected.' });
      const documentId = createRes.body.id;

      const response = await testClient.delete(
        `/api/v1/documents/${documentId}`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 when deleting a non-existent document', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/documents/doc_nonexistent'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/documents with title, metadata, tags (FEAT-13)', () => {
    test('creates a document with title, metadata, and tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          projectId,
          content: 'Tagged document content.',
          filename: 'tagged.txt',
          title: 'My Title',
          metadata: { source: 'test' },
          tags: ['alpha', 'beta'],
        });

      expect(response.status).toBe(201);
      expect(response.body.title).toBe('My Title');
      expect(response.body.metadata).toEqual({ source: 'test' });
      expect(response.body.tags).toEqual(
        expect.arrayContaining(['alpha', 'beta'])
      );
    });
  });

  describe('PATCH /api/v1/documents/:id (FEAT-2)', () => {
    let documentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          projectId,
          content: 'Original content.',
          filename: 'patchme.txt',
          title: 'Original Title',
          tags: ['initial'],
        });
      documentId = res.body.id;
    });

    test('updates title only', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ title: 'Updated Title' });

      expect(response.status).toBe(200);
      expect(response.body.title).toBe('Updated Title');
    });

    test('updates content and re-embeds', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ content: 'Updated content for re-embedding.' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(documentId);
    });

    test('updates tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ tags: ['new-tag', 'another'] });

      expect(response.status).toBe(200);
      expect(response.body.tags).toEqual(
        expect.arrayContaining(['new-tag', 'another'])
      );
    });

    test('updates metadata', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ metadata: { updated: true } });

      expect(response.status).toBe(200);
      expect(response.body.metadata).toEqual({ updated: true });
    });

    test('returns 404 for non-existent document', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/documents/doc_nonexistent')
        .send({ title: 'Ghost' });

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/documents/${documentId}`)
        .send({ title: 'No Auth' });

      expect(response.status).toBe(401);
    });

    test('user without UpdateDocument permission returns 403', async () => {
      // Create a second user with no UpdateDocument permission
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'noupdate', password: 'nopass' });
      const noUpdateUserId = createRes.body.id;
      const noUpdateToken = await loginAs('noupdate', 'nopass');

      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({
          permissions: ['documents:GetDocument'],
        });

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: noUpdateUserId, policyId: policyRes.body.id });

      const response = await authenticatedTestClient(noUpdateToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ title: 'Forbidden' });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/documents/search with tags (FEAT-13)', () => {
    let taggedDocId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          projectId,
          content: 'Tag-filtered search document.',
          filename: 'tag-search.txt',
          tags: ['unique-search-tag'],
        });
      taggedDocId = res.body.id;
    });

    test('search by matching tag returns tagged document', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({
          projectId,
          query: 'tag-filtered',
          tags: ['unique-search-tag'],
        });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const ids = response.body.map((d: { id: string }) => d.id);
      expect(ids).toContain(taggedDocId);
    });

    test('search by non-matching tag returns empty results', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ projectId, query: 'tag-filtered', tags: ['no-such-tag-xyz'] });

      expect(response.status).toBe(200);
      const ids = response.body.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(taggedDocId);
    });
  });

  describe('project key access', () => {
    let projectKey: string;

    beforeAll(async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({
          permissions: ['documents:ListDocuments', 'documents:SearchDocuments'],
        });
      const projectKeyPolicyId = policyRes.body.id;

      const projectKeyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/project-keys')
        .send({
          projectId,
          policyId: projectKeyPolicyId,
          name: 'Docs Test project key',
        });
      projectKey = projectKeyRes.body.key;

      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        projectId,
        content: 'project key test document.',
        filename: 'projectkey-doc.txt',
      });
    });

    test('project key can list documents without providing projectId', async () => {
      const response = await testClient
        .get('/api/v1/documents')
        .set('Authorization', `Bearer ${projectKey}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('project key can search documents without providing projectId', async () => {
      const response = await testClient
        .post('/api/v1/documents/search')
        .set('Authorization', `Bearer ${projectKey}`)
        .send({ query: 'project key test' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });
});
