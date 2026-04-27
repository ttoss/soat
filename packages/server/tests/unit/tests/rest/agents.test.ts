import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Agents', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;
  let aiProviderId: string;
  let noPermToken: string;

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
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
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
      .send({ username: 'agentsnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('agentsnoperm', 'nopassword');

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Agents Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
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
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'test-tool', project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('creates an agent tool with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'my-http-tool', project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^agt_tool_/);
      expect(response.body.name).toBe('my-http-tool');
      expect(response.body.type).toBe('http');
      expect(response.body.project_id).toBe(projectId);
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
          project_id: projectId,
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('client');
      expect(response.body.description).toBe('A client-side tool');
      expect(response.body.parameters).toBeDefined();
    });

    test('creates an http tool with execute.method set to GET', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({
          name: 'get-http-tool',
          type: 'http',
          description: 'A GET-based HTTP tool',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
          execute: {
            url: 'https://api.example.com/search',
            method: 'GET',
          },
          project_id: projectId,
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('http');
      const execute = response.body.execute as { url: string; method: string };
      expect(execute.method).toBe('GET');
      expect(execute.url).toBe('https://api.example.com/search');
    });

    test('creates an agent tool of type mcp', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({
          name: 'soat-mcp-tool',
          type: 'mcp',
          description: 'SOAT MCP server',
          mcp: {
            url: 'http://localhost:5047/mcp',
            headers: { Authorization: 'Bearer test-token' },
          },
          project_id: projectId,
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^agt_tool_/);
      expect(response.body.type).toBe('mcp');
      expect(response.body.description).toBe('SOAT MCP server');
      expect(response.body.mcp).toBeDefined();
      expect((response.body.mcp as { url: string }).url).toBe(
        'http://localhost:5047/mcp'
      );
    });
  });

  describe('GET /api/v1/agents/tools', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/agents/tools');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
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
        .send({ name: 'get-tool-test', project_id: projectId });
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
        .send({ name: 'update-tool-test', project_id: projectId });
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
        .send({ name: 'delete-tool-test', project_id: projectId });
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
        .send({ ai_provider_id: aiProviderId });

      expect(response.status).toBe(401);
    });

    test('missing aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('unknown aiProviderId returns 404', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          project_id: projectId,
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('creates an agent with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^agt_/);
      expect(response.body.ai_provider_id).toBe(aiProviderId);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.max_steps).toBe(20);
    });

    test('creates an agent with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'My Agent',
          instructions: 'Be helpful',
          model: 'llama3.2',
          max_steps: 5,
          temperature: 0.7,
        });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('My Agent');
      expect(response.body.instructions).toBe('Be helpful');
      expect(response.body.model).toBe('llama3.2');
      expect(response.body.max_steps).toBe(5);
      expect(response.body.temperature).toBe(0.7);
    });
  });

  describe('GET /api/v1/agents', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/agents');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
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
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Get Agent Test',
        });
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
      expect(response.body.ai_provider_id).toBe(aiProviderId);
    });
  });

  describe('PUT /api/v1/agents/:agentId', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Update Agent Test',
        });
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
          max_steps: 10,
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(agentId);
      expect(response.body.name).toBe('Renamed Agent');
      expect(response.body.instructions).toBe('New instructions');
      expect(response.body.max_steps).toBe(10);
    });

    test('can update agent with toolIds', async () => {
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/tools')
        .send({ name: 'tool-for-agent', project_id: projectId });
      const toolId = toolRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ tool_ids: [toolId] });

      expect(response.status).toBe(200);
      expect(response.body.tool_ids).toEqual([toolId]);
    });
  });

  describe('DELETE /api/v1/agents/:agentId', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
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
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Generation Agent',
        });
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

    test('accepts toolContext in request body', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          tool_context: { user_id: 'u1', env: 'test' },
        });

      expect(response.status).not.toBe(400);
    });

    test('user without CreateAgentGeneration permission returns 404 (no accessible projects)', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      // noPermToken has no policies → projectIds=[] → agent not found in empty scope
      expect(response.status).toBe(404);
    });
  });

  // ── Submit Tool Outputs ──────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/generate/:generationId/tool-outputs', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/agents/agt_someid/generate/agt_gen_someid/tool-outputs')
        .send({
          tool_outputs: [{ tool_call_id: 'tc_1', output: 'result' }],
        });

      expect(response.status).toBe(401);
    });

    test('missing toolOutputs returns 400', async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
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
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const agentId = agentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/agt_gen_fake/tool-outputs`)
        .send({ tool_outputs: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('generation_not_found returns 404 with valid toolOutputs', async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const agentId = agentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/generate/gen_doesnotexist000/tool-outputs`
        )
        .send({
          toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('user without CreateAgentGeneration permission returns 404 (no accessible projects)', async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const agentId = agentRes.body.id;

      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_fake/tool-outputs`)
        .send({
          toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
        });

      // noPermToken has no policies → projectIds=[] → agent not found in empty scope
      expect(response.status).toBe(404);
    });
  });

  // ── Traces ───────────────────────────────────────────────────────────────

  describe('GET /api/v1/agents/traces', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/agents/traces');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
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
