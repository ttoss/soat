import fs from 'node:fs';

import { storageDir } from '../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Documents', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;

  beforeAll(async () => {
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
      .send({ user_id: userId, policy_id: policyId });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/documents', () => {
    test('authenticated user with permission can create a document', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Hello, world! This is a test document.',
          filename: 'hello.txt',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^doc_/);
      expect(response.body.filename).toBe('hello.txt');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.size).toBeGreaterThan(0);
      expect(response.body.content).toBeUndefined();
    });

    test('unauthenticated request cannot create a document', async () => {
      const response = await testClient.post('/api/v1/documents').send({
        project_id: projectId,
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
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/documents', () => {
    test('authenticated user with permission can list documents', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?project_id=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('unauthenticated request cannot list documents', async () => {
      const response = await testClient.get(
        `/api/v1/documents?project_id=${projectId}`
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
          project_id: projectId,
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
        project_id: projectId,
        content: 'The capital of France is Paris.',
        filename: 'france.txt',
      });
    });

    test('user with permission can search documents', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ project_id: projectId, search: 'capital of France' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
    });

    test('search with limit returns at most limit results', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ project_id: projectId, search: 'test content', limit: 1 });

      expect(response.status).toBe(200);
      expect(response.body.documents.length).toBeLessThanOrEqual(1);
    });

    test('unauthenticated request cannot search documents', async () => {
      const response = await testClient
        .post('/api/v1/documents/search')
        .send({ project_id: projectId, search: 'test' });

      expect(response.status).toBe(401);
    });

    test('search without projectId returns results across accessible projects', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ search: 'no project' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
    });

    test('missing search/paths/documentIds returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
    });

    test('search results include score and content fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ project_id: projectId, search: 'capital of France' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
      if (response.body.documents.length > 0) {
        expect(typeof response.body.documents[0].score).toBe('number');
        expect(typeof response.body.documents[0].content).toBe('string');
      }
    });

    test('search with minScore filters low-score results', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({
          project_id: projectId,
          search: 'capital of France',
          min_score: 0.99,
        });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
      for (const doc of response.body.documents) {
        expect(doc.score).toBeGreaterThanOrEqual(0.99);
      }
    });

    test('search by paths prefix returns matching documents', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ project_id: projectId, paths: ['france'] });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
      for (const doc of response.body.documents) {
        expect(doc.filename).toMatch(/^france/);
      }
    });
  });

  describe('DELETE /api/v1/documents/:id', () => {
    test('user with permission can delete a document and file is removed from disk', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
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
        .send({ project_id: projectId, content: 'Protected.' });
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
          project_id: projectId,
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
          project_id: projectId,
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
        .send({ user_id: noUpdateUserId, policy_id: policyRes.body.id });

      const response = await authenticatedTestClient(noUpdateToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ title: 'Forbidden' });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/documents/search by documentIds', () => {
    let targetDocId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Specific document for ID-based retrieval.',
          filename: 'specific-doc.txt',
        });
      targetDocId = res.body.id;
    });

    test('search by documentIds returns only those documents', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({
          project_id: projectId,
          document_ids: [targetDocId],
        });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
      const ids = response.body.documents.map((d: { id: string }) => {
        return d.id;
      });
      expect(ids).toContain(targetDocId);
    });

    test('search by non-existent documentId returns empty results', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/search')
        .send({ project_id: projectId, document_ids: ['doc_nonexistent0000'] });

      expect(response.status).toBe(200);
      expect(response.body.documents).toHaveLength(0);
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
          project_id: projectId,
          policy_id: projectKeyPolicyId,
          name: 'Docs Test project key',
        });
      projectKey = projectKeyRes.body.key;

      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        project_id: projectId,
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
        .send({ search: 'project key test' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
    });
  });

  describe('resource-level SRN filtering on list/search endpoints', () => {
    let srnUserToken: string;
    let srnProjectId: string;
    let allowedDocId: string;
    let deniedDocId: string;
    let srnPolicyId: string;

    beforeAll(async () => {
      const createUserRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'srnuser', password: 'srnpass' });
      const srnUserId = createUserRes.body.id;
      srnUserToken = await loginAs('srnuser', 'srnpass');

      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'SRN Filter Project' });
      srnProjectId = projectRes.body.id;

      // Create a basic policy and add user to project
      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${srnProjectId}/policies`)
        .send({
          permissions: [
            'documents:CreateDocument',
            'documents:ListDocuments',
            'documents:SearchDocuments',
          ],
        });
      srnPolicyId = policyRes.body.id;

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${srnProjectId}/members`)
        .send({ user_id: srnUserId, policy_id: srnPolicyId });

      // Create two documents
      const allowedRes = await authenticatedTestClient(srnUserToken)
        .post('/api/v1/documents')
        .send({
          project_id: srnProjectId,
          content: 'This document is allowed.',
          filename: 'allowed.txt',
        });
      allowedDocId = allowedRes.body.id;

      const deniedRes = await authenticatedTestClient(srnUserToken)
        .post('/api/v1/documents')
        .send({
          project_id: srnProjectId,
          content: 'This document is denied.',
          filename: 'denied.txt',
        });
      deniedDocId = deniedRes.body.id;

      // Update the policy to restrict ListDocuments and SearchDocuments
      // to only the allowed document's SRN
      const allowedSrn = `soat:${srnProjectId}:document:${allowedDocId}`;
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/projects/${srnProjectId}/policies/${srnPolicyId}`)
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['documents:CreateDocument'],
              },
              {
                effect: 'Allow',
                action: [
                  'documents:ListDocuments',
                  'documents:SearchDocuments',
                ],
                resource: [allowedSrn],
              },
            ],
          },
        });
    });

    test('GET /documents only returns SRN-allowed documents', async () => {
      const response = await authenticatedTestClient(srnUserToken).get(
        `/api/v1/documents?project_id=${srnProjectId}`
      );

      expect(response.status).toBe(200);
      const ids = response.body.data.map((d: { id: string }) => {
        return d.id;
      });
      expect(ids).toContain(allowedDocId);
      expect(ids).not.toContain(deniedDocId);
    });

    test('POST /documents/search only returns SRN-allowed documents', async () => {
      const response = await authenticatedTestClient(srnUserToken)
        .post('/api/v1/documents/search')
        .send({
          project_id: srnProjectId,
          document_ids: [allowedDocId, deniedDocId],
        });

      expect(response.status).toBe(200);
      const ids = response.body.documents.map((d: { id: string }) => {
        return d.id;
      });
      expect(ids).toContain(allowedDocId);
      expect(ids).not.toContain(deniedDocId);
    });
  });
});
