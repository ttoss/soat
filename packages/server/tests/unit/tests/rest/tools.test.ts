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

    test('calling a soat tool without action returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${soatToolId}/call`)
        .send({});
      expect(response.status).toBe(400);
    });
  });

  describe('pipeline tools', () => {
    test('authenticated user can create a pipeline tool', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'greet-pipeline',
          type: 'pipeline',
          description: 'Greets the caller',
          pipeline: {
            nodes: [
              {
                type: 'map',
                expression: { cat: ['Hello ', { var: 'input.name' }] },
                output_key: 'greeting',
              },
            ],
            output_mapping: { answer: { var: 'greeting' } },
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('pipeline');
      // pipeline config is echoed verbatim in snake_case
      expect(response.body.pipeline.nodes[0].output_key).toBe('greeting');
      expect(response.body.pipeline.output_mapping).toBeDefined();
    });

    test('calling a map-only pipeline threads state and returns output_mapping shape', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'map-chain-pipeline',
          type: 'pipeline',
          pipeline: {
            nodes: [
              {
                type: 'map',
                expression: { cat: ['Hello ', { var: 'input.name' }] },
                output_key: 'greeting',
              },
              {
                type: 'map',
                expression: { var: 'greeting' },
                output_key: 'final',
              },
            ],
            output_mapping: { answer: { var: 'final' } },
          },
        });
      expect(createRes.status).toBe(201);

      const callRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${createRes.body.id}/call`)
        .send({ input: { name: 'World' } });

      expect(callRes.status).toBe(200);
      expect(callRes.body).toEqual({ answer: 'Hello World' });
    });

    test('pipeline without output_mapping returns the full state', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'full-state-pipeline',
          type: 'pipeline',
          pipeline: {
            nodes: [
              {
                type: 'map',
                expression: { var: 'input.name' },
                output_key: 'echoed',
              },
            ],
          },
        });
      expect(createRes.status).toBe(201);

      const callRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${createRes.body.id}/call`)
        .send({ input: { name: 'Ada' } });

      expect(callRes.status).toBe(200);
      expect(callRes.body.echoed).toBe('Ada');
      expect(callRes.body.input).toEqual({ name: 'Ada' });
    });

    test('calling a pipeline with an empty nodes array returns 400', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'invalid-pipeline',
          type: 'pipeline',
          pipeline: { nodes: [] },
        });
      expect(createRes.status).toBe(201);

      const callRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${createRes.body.id}/call`)
        .send({ input: {} });

      expect(callRes.status).toBe(400);
      expect(callRes.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a failing node aborts the pipeline with PIPELINE_STEP_FAILED', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'failing-pipeline',
          type: 'pipeline',
          pipeline: {
            nodes: [{ type: 'tool', tool_id: 'tool_does_not_exist' }],
          },
        });
      expect(createRes.status).toBe(201);

      const callRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${createRes.body.id}/call`)
        .send({ input: {} });

      expect(callRes.status).toBe(422);
      expect(callRes.body.error.code).toBe('PIPELINE_STEP_FAILED');
    });

    test('a self-referential pipeline aborts with PIPELINE_DEPTH_EXCEEDED', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'recursive-pipeline',
          type: 'pipeline',
          pipeline: {
            nodes: [{ type: 'map', expression: 1, output_key: 'x' }],
          },
        });
      expect(createRes.status).toBe(201);
      const selfId = createRes.body.id;

      // Point the pipeline at itself.
      const patchRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tools/${selfId}`)
        .send({ pipeline: { nodes: [{ type: 'tool', tool_id: selfId }] } });
      expect(patchRes.status).toBe(200);

      const callRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${selfId}/call`)
        .send({ input: {} });

      expect(callRes.status).toBe(422);
      expect(callRes.body.error.code).toBe('PIPELINE_DEPTH_EXCEEDED');
    });
  });
});
