import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Agents', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;
  let aiProviderId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'agentsadmin', password: 'supersecret' });

    adminToken = await loginAs('agentsadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'agentsuser', password: 'agentspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('agentsuser', 'agentspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Agents Test Project' });
    projectId = projectRes.body.id;

    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Agents Other Project' });
    otherProjectId = otherProjectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: [
          'agents:CreateAgent',
          'agents:ListAgents',
          'agents:GetAgent',
          'agents:UpdateAgent',
          'agents:DeleteAgent',
          'agents:CreateAgentGeneration',
          'agents:CreateAgentTool',
          'agents:ListAgentTools',
          'agents:GetAgentTool',
          'agents:UpdateAgentTool',
          'agents:DeleteAgentTool',
          'agents:ListAgentTraces',
          'agents:GetAgentTrace',
        ],
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId, policyId });

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        projectId,
        name: 'Agents Test Provider',
        provider: 'ollama',
        defaultModel: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
  });

  // ── Agent Tools CRUD ─────────────────────────────────────────────────────

  describe('POST /api/v1/agents/tools', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/agents/tools')
        .send({ name: 'test-tool' });

      expect(response.status).toBe(401);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ projectId });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'test-tool', projectId: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('creates an agent tool with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'my-http-tool', projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^agt_tool_/);
      expect(response.body.name).toBe('my-http-tool');
      expect(response.body.type).toBe('http');
      expect(response.body.projectId).toBe(projectId);
    });

    test('creates an agent tool with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({
          name: 'client-tool',
          type: 'client',
          description: 'A client-side tool',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
          projectId,
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('client');
      expect(response.body.description).toBe('A client-side tool');
      expect(response.body.parameters).toBeDefined();
    });
  });

  describe('GET /api/v1/agents/tools', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/agents/tools');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/agents/tools')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list agent tools', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/agents/tools')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
      expect(response.body[0].id).toMatch(/^agt_tool_/);
    });
  });

  describe('GET /api/v1/agents/tools/:toolId', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'get-tool-test', projectId });
      toolId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/agents/tools/${toolId}`);
      expect(response.status).toBe(401);
    });

    test('unknown toolId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/agents/tools/agt_tool_doesnotexist0000'
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('authenticated user can get an agent tool', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/tools/${toolId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(toolId);
      expect(response.body.name).toBe('get-tool-test');
    });
  });

  describe('PUT /api/v1/agents/tools/:toolId', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'update-tool-test', projectId });
      toolId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/agents/tools/${toolId}`)
        .send({ name: 'renamed' });
      expect(response.status).toBe(401);
    });

    test('unknown toolId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/agents/tools/agt_tool_doesnotexist0000')
        .send({ name: 'renamed' });
      expect(response.status).toBe(404);
    });

    test('authenticated user can update an agent tool', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/tools/${toolId}`)
        .send({ name: 'renamed-tool', description: 'Updated desc' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(toolId);
      expect(response.body.name).toBe('renamed-tool');
      expect(response.body.description).toBe('Updated desc');
    });
  });

  describe('DELETE /api/v1/agents/tools/:toolId', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'delete-tool-test', projectId });
      toolId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        `/api/v1/agents/tools/${toolId}`
      );
      expect(response.status).toBe(401);
    });

    test('unknown toolId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/agents/tools/agt_tool_doesnotexist0000'
      );
      expect(response.status).toBe(404);
    });

    test('authenticated user can delete an agent tool', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/tools/${toolId}`
      );
      expect(response.status).toBe(204);
    });

    test('deleted tool returns 404 on get', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/tools/${toolId}`
      );
      expect(response.status).toBe(404);
    });
  });

  // ── Agents CRUD ──────────────────────────────────────────────────────────

  describe('POST /api/v1/agents', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/agents')
        .send({ aiProviderId });

      expect(response.status).toBe(401);
    });

    test('missing aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ projectId });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('unknown aiProviderId returns 404', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({ aiProviderId: 'aip_doesnotexist000000', projectId });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('creates an agent with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^agt_/);
      expect(response.body.aiProviderId).toBe(aiProviderId);
      expect(response.body.projectId).toBe(projectId);
      expect(response.body.maxSteps).toBe(20);
    });

    test('creates an agent with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          aiProviderId,
          projectId,
          name: 'My Agent',
          instructions: 'Be helpful',
          model: 'llama3.2',
          maxSteps: 5,
          temperature: 0.7,
        });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('My Agent');
      expect(response.body.instructions).toBe('Be helpful');
      expect(response.body.model).toBe('llama3.2');
      expect(response.body.maxSteps).toBe(5);
      expect(response.body.temperature).toBe(0.7);
    });
  });

  describe('GET /api/v1/agents', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/agents');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/agents')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list agents', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/agents')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
      expect(response.body[0].id).toMatch(/^agt_/);
    });
  });

  describe('GET /api/v1/agents/:agentId', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId, name: 'Get Agent Test' });
      agentId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/agents/${agentId}`);
      expect(response.status).toBe(401);
    });

    test('unknown agentId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/agents/agt_doesnotexist0000'
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('authenticated user can get an agent', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(agentId);
      expect(response.body.name).toBe('Get Agent Test');
      expect(response.body.aiProviderId).toBe(aiProviderId);
    });
  });

  describe('PUT /api/v1/agents/:agentId', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId, name: 'Update Agent Test' });
      agentId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/agents/${agentId}`)
        .send({ name: 'renamed' });
      expect(response.status).toBe(401);
    });

    test('unknown agentId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/agents/agt_doesnotexist0000')
        .send({ name: 'renamed' });
      expect(response.status).toBe(404);
    });

    test('authenticated user can update an agent', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({
          name: 'Renamed Agent',
          instructions: 'New instructions',
          maxSteps: 10,
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(agentId);
      expect(response.body.name).toBe('Renamed Agent');
      expect(response.body.instructions).toBe('New instructions');
      expect(response.body.maxSteps).toBe(10);
    });

    test('can update agent with toolIds', async () => {
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'tool-for-agent', projectId });
      const toolId = toolRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ toolIds: [toolId] });

      expect(response.status).toBe(200);
      expect(response.body.toolIds).toEqual([toolId]);
    });
  });

  describe('DELETE /api/v1/agents/:agentId', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId });
      agentId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(`/api/v1/agents/${agentId}`);
      expect(response.status).toBe(401);
    });

    test('unknown agentId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/agents/agt_doesnotexist0000'
      );
      expect(response.status).toBe(404);
    });

    test('authenticated user can delete an agent', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentId}`
      );
      expect(response.status).toBe(204);
    });

    test('deleted agent returns 404 on get', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(response.status).toBe(404);
    });
  });

  // ── Generation ───────────────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/generate', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId, name: 'Generation Agent' });
      agentId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(401);
    });

    test('missing messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty messages array returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('unknown agentId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/agt_doesnotexist0000/generate')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });
  });

  // ── Submit Tool Outputs ──────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/generate/:generationId/tool-outputs', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/agents/agt_someid/generate/agt_gen_someid/tool-outputs')
        .send({
          toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
        });

      expect(response.status).toBe(401);
    });

    test('missing toolOutputs returns 400', async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId });
      const agentId = agentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/agt_gen_fake/tool-outputs`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty toolOutputs array returns 400', async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ aiProviderId, projectId });
      const agentId = agentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/agt_gen_fake/tool-outputs`)
        .send({ toolOutputs: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });
  });

  // ── Traces ───────────────────────────────────────────────────────────────

  describe('GET /api/v1/agents/traces', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/agents/traces');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/agents/traces')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list traces', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/agents/traces')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('GET /api/v1/agents/traces/:traceId', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        '/api/v1/agents/traces/agt_trace_fake'
      );
      expect(response.status).toBe(401);
    });

    test('unknown traceId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/agents/traces/agt_trace_doesnotexist0000'
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });
  });
});
