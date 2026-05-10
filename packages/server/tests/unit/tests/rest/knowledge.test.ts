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
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/knowledge/search', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, paths: ['/docs/'] });
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
        .send({ project_id: projectId, paths: ['/docs/'] });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      if (response.body.results.length > 0) {
        const result = response.body.results[0];
        expect(result.source_type).toBe('document');
        expect(result.document_id).toMatch(/^doc_/);
        expect(result.project_id).toBe(projectId);
      }
    });

    test('returns 403 when user has no permission', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, paths: ['/docs/'] });
      expect(response.status).toBe(403);
    });

    test('returns results array in response body', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, paths: ['/'] });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('results');
      expect(Array.isArray(response.body.results)).toBe(true);
    });
  });
});
