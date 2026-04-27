import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Projects', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'alice', password: 'alicepass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('alice', 'alicepass');
  });

  describe('POST /api/v1/projects', () => {
    test('admin can create a project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'My Project' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('My Project');
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('unauthenticated request cannot create a project', async () => {
      const response = await testClient
        .post('/api/v1/projects')
        .send({ name: 'Unauthorized Project' });

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot create a project', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/projects')
        .send({ name: 'Forbidden Project' });

      expect(response.status).toBe(403);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/projects', () => {
    test('admin can list all projects', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request cannot list projects', async () => {
      const response = await testClient.get('/api/v1/projects');

      expect(response.status).toBe(401);
    });

    test('user with no policies sees no projects', async () => {
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [] });

      const response =
        await authenticatedTestClient(userToken).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(0);
    });

    describe('api key scoped to project sees only that project', () => {
      let projectAId: string;
      let rawApiKey: string;

      beforeAll(async () => {
        const projARes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'api key Scope Project A' });

        projectAId = projARes.body.id;

        await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'api key Scope Project B' });

        const listPolicyRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/policies')
          .send({
            document: {
              statement: [
                { effect: 'Allow', action: ['projects:ListProjects'] },
              ],
            },
          });

        await authenticatedTestClient(adminToken)
          .put(`/api/v1/users/${userId}/policies`)
          .send({ policy_ids: [listPolicyRes.body.id] });

        const apiKeyRes = await authenticatedTestClient(userToken)
          .post('/api/v1/api-keys')
          .send({ name: 'Scoped Key', project_id: projectAId });

        rawApiKey = apiKeyRes.body.key;
      });

      test('api key only sees its scoped project', async () => {
        const response =
          await authenticatedTestClient(rawApiKey).get('/api/v1/projects');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(1);
        expect(response.body[0].id).toBe(projectAId);
      });

      afterAll(async () => {
        await authenticatedTestClient(adminToken)
          .put(`/api/v1/users/${userId}/policies`)
          .send({ policy_ids: [] });
      });
    });
  });

  describe('GET /api/v1/projects/:id', () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Gettable Project' });

      projectId = res.body.id;
    });

    test('admin can get any project', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(projectId);
      expect(response.body.name).toBe('Gettable Project');
    });

    test('unauthenticated request cannot get a project', async () => {
      const response = await testClient.get(`/api/v1/projects/${projectId}`);

      expect(response.status).toBe(401);
    });

    test('user with no policies cannot get a project', async () => {
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [] });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(403);
    });

    test('user with projects:GetProject policy can get a project', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['projects:GetProject'] }],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(projectId);

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [] });
    });

    test('returns 404 for unknown project id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/projects/proj_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/projects/:id', () => {
    test('admin can delete a project', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'To Delete' });

      const { id } = createRes.body;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${id}`
      );

      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${id}`
      );

      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request cannot delete a project', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Not Deletable Unauth' });

      const { id } = createRes.body;
      const response = await testClient.delete(`/api/v1/projects/${id}`);

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot delete a project', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Not Deletable User' });

      const { id } = createRes.body;
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/projects/${id}`
      );

      expect(response.status).toBe(403);
    });

    test('returns 404 when deleting non-existent project', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/projects/proj_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });

    test('deleting a project removes api keys scoped to it', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Cascade Test Project' });

      expect(projRes.status).toBe(201);
      const cascadeProjectId = projRes.body.id;

      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Cascade Key', project_id: cascadeProjectId });

      expect(keyRes.status).toBe(201);
      const keyId = keyRes.body.id;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${cascadeProjectId}`
      );

      expect(deleteRes.status).toBe(204);

      const getProjectRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${cascadeProjectId}`
      );

      expect(getProjectRes.status).toBe(404);

      const getKeyRes = await authenticatedTestClient(userToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(getKeyRes.status).toBe(404);
    });
  });
});
