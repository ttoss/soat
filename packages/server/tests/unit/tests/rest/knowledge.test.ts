import fs from 'node:fs';

import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Knowledge', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let noPermToken: string;
  let memoryId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'knowledgeuser', password: 'knowledgepass' });
    userId = createUserRes.body.id;
    userToken = await loginAs('knowledgeuser', 'knowledgepass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Knowledge Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['documents:CreateDocument', 'knowledge:SearchKnowledge'],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'knowledgenoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('knowledgenoperm', 'nopassword');

    // Create a document for search tests
    await authenticatedTestClient(userToken).post('/api/v1/documents').send({
      project_id: projectId,
      content: 'The quick brown fox jumps over the lazy dog.',
      filename: 'sample.txt',
      path: '/docs/sample.txt',
    });

    // Create a memory with an entry for memory search tests (admin has full permissions)
    const memoryRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memories')
      .send({
        project_id: projectId,
        name: 'Knowledge Test Memory',
        tags: ['knowledge-test'],
      });
    memoryId = memoryRes.body.id;
    await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-entries')
      .send({
        memory_id: memoryId,
        content: 'The sky is blue on a clear day.',
      });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/knowledge/search', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/knowledge/search').send({
        project_id: projectId,
        document_paths: ['/docs/'],
      });
      expect(response.status).toBe(401);
    });

    test('returns 400 when no query, paths, or documentIds provided', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId });
      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('returns results with source_type document when searching by path', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          document_paths: ['/docs/'],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      if (response.body.results.length > 0) {
        const result = response.body.results[0];
        expect(result.source_type).toBe('document');
        expect(result.document_id).toMatch(/^doc_/);
        expect(result.chunk_id).toMatch(/^dchunk_/);
        expect(result.project_id).toBe(projectId);
      }
    });

    test('returns 403 when user has no permission', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          document_paths: ['/docs/'],
        });
      expect(response.status).toBe(403);
    });

    test('returns results array in response body', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, document_paths: ['/'] });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('results');
      expect(Array.isArray(response.body.results)).toBe(true);
    });

    test('returns memory entries when searching by memory_ids', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_ids: [memoryId],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
      expect(memResult.entry_id).toBeDefined();
      expect(memResult.memory_id).toBe(memoryId);
      expect(memResult.memory_name).toBe('Knowledge Test Memory');
      expect(memResult.content).toBe('The sky is blue on a clear day.');
    });

    test('returns memory entries when searching by memory_tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_tags: ['knowledge-test'],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
      expect(memResult.source_type).toBe('memory');
    });

    test('returns mixed results when searching with query, document_filters, and memory_ids', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'sky',
          document_paths: ['/docs/'],
          memory_ids: [memoryId],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
    });

    test('returns empty array when memory_ids has no matching entries', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_ids: ['mem_doesnotexist000'],
        });
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([]);
    });
  });
});
