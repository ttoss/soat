import http from 'node:http';
import type { AddressInfo } from 'node:net';

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

  describe('Pipeline tools', () => {
    let pipelineToolId: string;

    test('creates a pipeline tool referencing existing tools', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'compute-and-list',
          type: 'pipeline',
          description: 'Runs two steps in order',
          parameters: {
            type: 'object',
            properties: { n: { type: 'number' } },
          },
          pipeline: {
            steps: [
              {
                id: 'first',
                tool_id: soatToolId,
                action: 'list-tools',
                input: {},
              },
              {
                id: 'second',
                tool_id: soatToolId,
                action: 'list-tools',
                input: { note: { var: 'steps.first' } },
              },
            ],
            output: { echo: { var: 'input.n' } },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^tool_/);
      expect(res.body.type).toBe('pipeline');
      expect(res.body.pipeline).toBeDefined();
      expect(res.body.pipeline.steps).toHaveLength(2);
      expect(res.body.pipeline.steps[0].tool_id).toBe(soatToolId);
      pipelineToolId = res.body.id;
    });

    test('GET returns the stored pipeline config (snake_case)', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/tools/${pipelineToolId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.pipeline.steps[0].action).toBe('list-tools');
      expect(res.body.pipeline.output).toEqual({ echo: { var: 'input.n' } });
    });

    test('rejects a pipeline with no steps (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'empty-pipeline',
          type: 'pipeline',
          pipeline: { steps: [] },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PIPELINE_INVALID_STEP');
    });

    test('rejects a pipeline referencing an unknown tool (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'unknown-step',
          type: 'pipeline',
          pipeline: { steps: [{ id: 'a', tool_id: 'tool_doesnotexist' }] },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PIPELINE_INVALID_STEP');
    });

    test('rejects a pipeline whose step targets a client tool (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'client-step',
          type: 'pipeline',
          pipeline: { steps: [{ id: 'a', tool_id: clientToolId }] },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PIPELINE_INVALID_STEP');
    });

    test('rejects a pipeline with a forward step reference (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'forward-ref',
          type: 'pipeline',
          pipeline: {
            steps: [
              {
                id: 'a',
                tool_id: soatToolId,
                input: { x: { var: 'steps.b.v' } },
              },
              { id: 'b', tool_id: soatToolId },
            ],
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PIPELINE_INVALID_STEP');
    });

    test('rejects a pipeline with duplicate step ids (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'dup-ids',
          type: 'pipeline',
          pipeline: {
            steps: [
              { id: 'a', tool_id: soatToolId },
              { id: 'a', tool_id: soatToolId },
            ],
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PIPELINE_INVALID_STEP');
    });

    test('calling the pipeline runs the steps and wraps a failing step (422)', async () => {
      // SOAT steps make an internal HTTP call that is unreachable from unit
      // tests, so the first step fails and the runner wraps it as
      // PIPELINE_STEP_FAILED — proving dispatch reaches the step.
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/tools/${pipelineToolId}/call`)
        .send({ input: { n: 1 } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PIPELINE_STEP_FAILED');
      expect(res.body.error.meta.step_id).toBe('first');
    });

    test('unauthenticated pipeline call returns 401', async () => {
      const res = await testClient
        .post(`/api/v1/tools/${pipelineToolId}/call`)
        .send({ input: {} });
      expect(res.status).toBe(401);
    });

    test('pipeline call without permission returns 403 or 404', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/tools/${pipelineToolId}/call`)
        .send({ input: {} });
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('Secret references ({{secret:...}}) in tool configs', () => {
    let secretId: string;
    let otherProjectSecretId: string;
    let echoServer: http.Server;
    let echoServerUrl: string;
    let lastRequest: {
      url: string | undefined;
      authorization: string | undefined;
      apiKey: string | undefined;
    };

    beforeAll(async () => {
      const secretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'third-party-api-key',
          value: 'sk-live-topsecret',
        });
      expect(secretRes.status).toBe(201);
      secretId = secretRes.body.id;

      const otherProjectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Other Secrets Project' });
      const otherSecretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: otherProjectRes.body.id,
          name: 'other-project-key',
          value: 'other-value',
        });
      expect(otherSecretRes.status).toBe(201);
      otherProjectSecretId = otherSecretRes.body.id;

      echoServer = http.createServer((req, res) => {
        lastRequest = {
          url: req.url,
          authorization: req.headers.authorization,
          apiKey:
            typeof req.headers['x-api-key'] === 'string'
              ? req.headers['x-api-key']
              : undefined,
        };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => {
        echoServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = echoServer.address() as AddressInfo;
      echoServerUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        echoServer.close(() => {
          resolve();
        });
      });
    });

    test('creating an http tool with a valid secret ref stores and echoes the raw token', async () => {
      const token = `Bearer {{secret:${secretId}}}`;
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'secret-ref-echo-tool',
          type: 'http',
          execute: {
            url: `${echoServerUrl}/convert`,
            method: 'POST',
            headers: { Authorization: token },
          },
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.execute.headers.Authorization).toBe(token);

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${createRes.body.id}`
      );
      expect(getRes.status).toBe(200);
      // The stored reference — never the resolved value — is echoed back.
      expect(getRes.body.execute.headers.Authorization).toBe(token);
    });

    test('creating an http tool referencing a nonexistent secret returns 400', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'secret-ref-missing-tool',
          type: 'http',
          execute: {
            url: `${echoServerUrl}/convert`,
            headers: { Authorization: 'Bearer {{secret:sec_doesnotexist00}}' },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SECRET_NOT_FOUND');
    });

    test('creating an http tool referencing a secret from another project returns 400', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'secret-ref-cross-project-tool',
          type: 'http',
          execute: {
            url: `${echoServerUrl}/convert`,
            headers: {
              Authorization: `Bearer {{secret:${otherProjectSecretId}}}`,
            },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SECRET_NOT_FOUND');
    });

    test('updating a tool with an invalid secret ref returns 400', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'secret-ref-update-tool',
          type: 'http',
          execute: { url: `${echoServerUrl}/convert` },
        });
      expect(createRes.status).toBe(201);

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/tools/${createRes.body.id}`)
        .send({
          execute: {
            url: `${echoServerUrl}/convert`,
            headers: { Authorization: 'Bearer {{secret:sec_doesnotexist00}}' },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SECRET_NOT_FOUND');
    });

    test('creating an mcp tool with an invalid secret ref in mcp.headers returns 400', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'secret-ref-mcp-tool',
          type: 'mcp',
          mcp: {
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: 'Bearer {{secret:sec_doesnotexist00}}' },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SECRET_NOT_FOUND');
    });

    test('calling an http tool resolves secret refs in headers and url at call time', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'secret-ref-call-tool',
          type: 'http',
          execute: {
            url: `${echoServerUrl}/convert?key={{secret:${secretId}}}`,
            method: 'POST',
            headers: {
              Authorization: `Bearer {{secret:${secretId}}}`,
              'X-Api-Key': `{{secret:${secretId}}}`,
            },
          },
        });
      expect(createRes.status).toBe(201);

      const callRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/tools/${createRes.body.id}/call`)
        .send({ input: { q: 'hello' } });

      expect(callRes.status).toBe(200);
      expect(lastRequest.authorization).toBe('Bearer sk-live-topsecret');
      expect(lastRequest.apiKey).toBe('sk-live-topsecret');
      expect(lastRequest.url).toContain('key=sk-live-topsecret');
    });
  });
});
