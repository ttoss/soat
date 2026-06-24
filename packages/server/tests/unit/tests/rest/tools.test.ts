import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Tools', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let noPermToken: string;
  let toolId: string;
  let soatToolId: string;
  let clientToolId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'toolsadmin', password: 'supersecret' });

    adminToken = await loginAs('toolsadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'toolsuser', password: 'toolspass' });
    userId = createUserRes.body.id;
    userToken = await loginAs('toolsuser', 'toolspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Tools Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'tools:CreateTool',
                'tools:ListTools',
                'tools:GetTool',
                'tools:UpdateTool',
                'tools:DeleteTool',
                'tools:CallTool',
              ],
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
      .send({ username: 'toolsnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('toolsnoperm', 'nopassword');

    // Create a SOAT tool for call tests
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'soat-tools-list',
        type: 'soat',
        description: 'Lists tools via SOAT',
        actions: ['list-tools'],
      });
    soatToolId = soatToolRes.body.id;

    // Create a client tool for call tests
    const clientToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'client-dialog',
        type: 'client',
        description: 'A client-side dialog tool',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      });
    clientToolId = clientToolRes.body.id;
  });

  describe('POST /api/v1/tools — execute.headers case preservation', () => {
    test('HTTP headers in execute config are preserved exactly as given (not case-transformed)', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'header-case-test-tool',
          type: 'http',
          description: 'Tool to test header case preservation',
          execute: {
            url: 'https://example.com/api/delete',
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.execute).toBeDefined();
      expect(response.body.execute.headers).toBeDefined();
      expect(response.body.execute.headers['Content-Type']).toBe(
        'application/json'
      );
      expect(response.body.execute.headers['_content-_type']).toBeUndefined();
    });
  });

  describe('POST /api/v1/tools', () => {
    test('authenticated user with permission can create a tool', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'My HTTP Tool',
          type: 'http',
          description: 'A test HTTP tool',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^tool_/);
      expect(response.body.name).toBe('My HTTP Tool');
      expect(response.body.type).toBe('http');
      expect(response.body.description).toBe('A test HTTP tool');
      toolId = response.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'Tool' });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'Tool' });
      expect(response.status).toBe(403);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId });
      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/tools', () => {
    test('authenticated user can list tools', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/tools')
        .query({ project_id: projectId });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/tools');
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/tools')
        .query({ project_id: projectId });
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/tools/:tool_id', () => {
    test('authenticated user can get a tool', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/tools/${toolId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(toolId);
      expect(response.body.name).toBe('My HTTP Tool');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/tools/${toolId}`);
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/tools/${toolId}`
      );
      expect([403, 404]).toContain(response.status);
    });

    test('non-existent tool returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/tools/tool_nonexistent'
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/tools/:tool_id', () => {
    test('authenticated user can update a tool', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ name: 'Updated Tool Name' });
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(toolId);
      expect(response.body.name).toBe('Updated Tool Name');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/tools/${toolId}`)
        .send({ name: 'X' });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ name: 'X' });
      expect([403, 404]).toContain(response.status);
    });

    test('non-existent tool returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/tools/tool_nonexistent')
        .send({ name: 'X' });
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/tools/:tool_id', () => {
    test('authenticated user can delete a tool', async () => {
      const toDelete = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'To Delete', type: 'http' });
      expect(toDelete.status).toBe(201);

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/tools/${toDelete.body.id}`
      );
      expect(response.status).toBe(204);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(`/api/v1/tools/${toolId}`);
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/tools/${toolId}`
      );
      expect([403, 404]).toContain(response.status);
    });

    test('non-existent tool returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/tools/tool_nonexistent'
      );
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/tools/${soatToolId}/call`)
        .send({ action: 'list-tools' });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/tools/${soatToolId}/call`)
        .send({ action: 'list-tools' });
      expect([403, 404]).toContain(response.status);
    });

    test('non-existent tool returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools/tool_nonexistent/call')
        .send({ action: 'list-tools' });
      expect(response.status).toBe(404);
    });

    test('calling a client tool returns 422', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${clientToolId}/call`)
        .send({});
      expect(response.status).toBe(422);
    });

    test('calling a soat tool without action returns 400 with operationId in error message', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${soatToolId}/call`)
        .send({});
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/operationId/i);
    });

    test('calling a soat tool via preset_parameters.action does not return operationId-required error', async () => {
      const presetToolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'soat-preset-action-tool',
          type: 'soat',
          description: 'SOAT tool with preset action',
          actions: ['list-tools'],
          preset_parameters: { action: 'list-tools' },
        });
      expect(presetToolRes.status).toBe(201);
      const presetToolId = presetToolRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${presetToolId}/call`)
        .send({});
      // The action is extracted from presetParameters so it must NOT fail with
      // the "operationId required" validation error (400). The internal SOAT HTTP
      // call may fail in the test environment (500), which is expected.
      expect(response.status).not.toBe(400);
    });
  });
});
