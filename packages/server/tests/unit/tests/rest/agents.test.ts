import { db } from 'src/db';
import * as knowledgeModule from 'src/lib/knowledge';
import { saveTrace } from 'src/lib/traces';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Agents', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let aiProviderId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'agents',
      policyActions: [
        'agents:CreateAgent',
        'agents:ListAgents',
        'agents:GetAgent',
        'agents:UpdateAgent',
        'agents:DeleteAgent',
        'agents:CreateAgentGeneration',
        'tools:CreateTool',
        'tools:ListTools',
        'tools:GetTool',
        'tools:UpdateTool',
        'tools:DeleteTool',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;

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

  describe('POST /api/v1/tools', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/tools')
        .send({ name: 'test-tool' });

      expect(response.status).toBe(401);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/tools')
        .send({ name: 'test-tool', project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('returns 400 when parameters is a non-object string', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          name: 'bad-tool',
          project_id: projectId,
          parameters: 'not-json',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/JSON object/);
    });

    test('coerces JSON-encoded string parameters to an object', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          name: 'coerced-tool',
          project_id: projectId,
          parameters: JSON.stringify({ type: 'object', properties: {} }),
        });

      expect(response.status).toBe(201);
      expect(response.body.parameters).toEqual({
        type: 'object',
        properties: {},
      });
    });

    test('creates an agent tool with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'my-http-tool', project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^tool_/);
      expect(response.body.name).toBe('my-http-tool');
      expect(response.body.type).toBe('http');
      expect(response.body.project_id).toBe(projectId);
    });

    test('creates an agent tool with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
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
        .post('/api/v1/tools')
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
        .post('/api/v1/tools')
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
      expect(response.body.id).toMatch(/^tool_/);
      expect(response.body.type).toBe('mcp');
      expect(response.body.description).toBe('SOAT MCP server');
      expect(response.body.mcp).toBeDefined();
      expect((response.body.mcp as { url: string }).url).toBe(
        'http://localhost:5047/mcp'
      );
    });
  });

  describe('GET /api/v1/tools', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/tools');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/tools')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list agent tools', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/tools')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
      expect(response.body[0].id).toMatch(/^tool_/);
    });
  });

  describe('GET /api/v1/tools/:toolId', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'get-tool-test', project_id: projectId });
      toolId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/tools/${toolId}`);
      expect(response.status).toBe(401);
    });

    test('unknown toolId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/tools/tool_doesnotexist0000'
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('authenticated user can get an agent tool', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/tools/${toolId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(toolId);
      expect(response.body.name).toBe('get-tool-test');
    });
  });

  describe('PATCH /api/v1/tools/:toolId', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'update-tool-test', project_id: projectId });
      toolId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/tools/${toolId}`)
        .send({ name: 'renamed' });
      expect(response.status).toBe(401);
    });

    test('unknown toolId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/tools/tool_doesnotexist0000')
        .send({ name: 'renamed' });
      expect(response.status).toBe(404);
    });

    test('authenticated user can update an agent tool', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ name: 'renamed-tool', description: 'Updated desc' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(toolId);
      expect(response.body.name).toBe('renamed-tool');
      expect(response.body.description).toBe('Updated desc');
    });
  });

  describe('DELETE /api/v1/tools/:toolId', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'delete-tool-test', project_id: projectId });
      toolId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(`/api/v1/tools/${toolId}`);
      expect(response.status).toBe(401);
    });

    test('unknown toolId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/tools/tool_doesnotexist0000'
      );
      expect(response.status).toBe(404);
    });

    test('authenticated user can delete an agent tool', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/tools/${toolId}`
      );
      expect(response.status).toBe(204);
    });

    test('deleted tool returns 404 on get', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/tools/${toolId}`
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

    test('non-string aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ project_id: projectId, ai_provider_id: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('unknown aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          project_id: projectId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('creates an agent with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^agent_/);
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

    test('max_context_messages defaults to null when not specified', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.max_context_messages).toBeNull();
    });

    test('creates an agent with max_context_messages', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          max_context_messages: 10,
        });

      expect(response.status).toBe(201);
      expect(response.body.max_context_messages).toBe(10);
    });

    test('unknown fields in body return 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          prompt: 'should be instructions',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/prompt/);
    });

    test('creates an agent with output_schema', async () => {
      const outputSchema = {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      };

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          output_schema: outputSchema,
        });

      expect(response.status).toBe(201);
      expect(response.body.output_schema).toEqual(outputSchema);
    });

    test('output_schema defaults to null when not specified', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.output_schema).toBeNull();
    });

    test('rejects a non-object output_schema', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          output_schema: 'not-an-object',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_OUTPUT_SCHEMA');
    });

    test('creates an agent with an ephemeral inline tool, echoed back but not persisted as a Tool', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tools: [
            {
              name: 'inline-weather-tool',
              description: 'Gets the weather',
              execute: { url: 'https://example.com/weather' },
            },
          ],
        });

      expect(response.status).toBe(201);
      expect(response.body.tools).toEqual([
        {
          name: 'inline-weather-tool',
          description: 'Gets the weather',
          execute: { url: 'https://example.com/weather' },
        },
      ]);
      // Ephemeral — no separate Tool resource is created, so tool_ids is untouched.
      expect(response.body.tool_ids).toBeNull();

      const toolsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/tools?project_id=${projectId}`
      );
      expect(
        (toolsRes.body as Array<{ name: string }>).some((t) => {
          return t.name === 'inline-weather-tool';
        })
      ).toBe(false);
    });

    test('keeps tool_ids and tools independent', async () => {
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'preexisting-tool', project_id: projectId });
      const existingToolId = toolRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tool_ids: [existingToolId],
          tools: [{ name: 'inline-tool-merge' }],
        });

      expect(response.status).toBe(201);
      expect(response.body.tool_ids).toEqual([existingToolId]);
      expect(response.body.tools).toEqual([{ name: 'inline-tool-merge' }]);
    });

    test('rejects an ephemeral tool definition of type pipeline', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tools: [{ name: 'inline-pipeline', type: 'pipeline' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/pipeline/i);
    });

    test('inline tool definition without a name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tools: [{ description: 'missing a name' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/tools/i);
    });

    test('non-object inline tool definition returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tools: [123],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('non-array tools returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tools: 'not-an-array',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('creates an agent with stop_conditions, active_tool_ids, step_rules, and single_session_per_actor', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          stop_conditions: [],
          active_tool_ids: [],
          step_rules: [],
          single_session_per_actor: true,
        });

      expect(response.status).toBe(201);
      expect(response.body.single_session_per_actor).toBe(true);
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
      expect(response.body[0].id).toMatch(/^agent_/);
    });

    test('admin can list agents across all projects without a project_id filter', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/agents');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
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

    test('can update max_context_messages', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ max_context_messages: 5 });

      expect(response.status).toBe(200);
      expect(response.body.max_context_messages).toBe(5);
    });

    test('can update agent with toolIds', async () => {
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'tool-for-agent', project_id: projectId });
      const toolId = toolRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ tool_ids: [toolId] });

      expect(response.status).toBe(200);
      expect(response.body.tool_ids).toEqual([toolId]);
    });

    test('non-array tools returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ tools: 'not-an-array' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('can update agent with an ephemeral inline tool', async () => {
      const freshAgentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const freshAgentId = freshAgentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${freshAgentId}`)
        .send({ tools: [{ name: 'inline-tool-on-update' }] });

      expect(response.status).toBe(200);
      expect(response.body.tools).toEqual([{ name: 'inline-tool-on-update' }]);
    });

    test('can clear tools by setting it to null', async () => {
      const freshAgentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tools: [{ name: 'to-be-cleared' }],
        });
      const freshAgentId = freshAgentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${freshAgentId}`)
        .send({ tools: null });

      expect(response.status).toBe(200);
      expect(response.body.tools).toBeNull();
    });

    test('unknown fields in PUT body return 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ prompt: 'should be instructions' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/prompt/);
    });

    test('can update output_schema', async () => {
      const outputSchema = {
        type: 'object',
        properties: { answer: { type: 'string' } },
      };

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ output_schema: outputSchema });

      expect(response.status).toBe(200);
      expect(response.body.output_schema).toEqual(outputSchema);
    });

    test('can clear output_schema by setting it to null', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ output_schema: null });

      expect(response.status).toBe(200);
      expect(response.body.output_schema).toBeNull();
    });
  });

  describe('PATCH /api/v1/agents/:agentId', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Patch Agent Test',
        });
      agentId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/agents/${agentId}`)
        .send({ name: 'renamed' });
      expect(response.status).toBe(401);
    });

    test('unknown agentId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/agents/agt_doesnotexist0000')
        .send({ name: 'renamed' });
      expect(response.status).toBe(404);
    });

    test('authenticated user can partially update an agent via PATCH', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ name: 'Patched Agent', max_steps: 7 });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Patched Agent');
      expect(response.body.max_steps).toBe(7);
    });

    test('unknown fields in PATCH body return 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ prompt: 'should be instructions' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/prompt/);
    });

    test('non-array tools returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ tools: 'not-an-array' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('can update ai_provider_id and single_session_per_actor via PATCH', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({
          ai_provider_id: aiProviderId,
          single_session_per_actor: true,
        });

      expect(response.status).toBe(200);
      expect(response.body.ai_provider_id).toBe(aiProviderId);
      expect(response.body.single_session_per_actor).toBe(true);
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

    test('returns 409 when the agent has dependent traces', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Agent With Trace',
        });
      const blockedAgentId = createRes.body.id as string;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      expect(project).not.toBeNull();

      await saveTrace({
        traceId: `trc_agent_delete_${Date.now()}`,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: blockedAgentId,
        steps: [{ type: 'text-delta', text: 'hello' }],
      });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${blockedAgentId}`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('AGENT_HAS_DEPENDENTS');
    });

    test('deleted agent returns 404 on get', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(response.status).toBe(404);
    });

    test('returns 409 when the agent has dependent generations', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Agent With Generation',
        });
      const blockedAgentId = createRes.body.id as string;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const agent = await db.Agent.findOne({
        where: { publicId: blockedAgentId },
      });

      const traceId = `trc_del_gen_${Date.now()}`;
      await saveTrace({
        traceId,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: blockedAgentId,
        steps: [{ type: 'text-delta', text: 'hello' }],
      });
      const trace = await db.Trace.findOne({ where: { publicId: traceId } });

      await db.Generation.create({
        publicId: `gen_del_${Date.now()}`,
        projectId: project!.id as number,
        agentId: agent!.id as number,
        traceId: trace!.id as number,
        initiatorGenerationId: null,
        startedByActorId: null,
        startedByPrincipalType: null,
        startedByPrincipalId: null,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        lastActivityAt: new Date(),
        stopReason: 'stop',
        metadata: null,
      });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${blockedAgentId}`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('AGENT_HAS_DEPENDENTS');
    });

    test('force=true deletes an agent along with its dependent generations and traces', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Agent Force Delete',
        });
      const forceAgentId = createRes.body.id as string;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const agent = await db.Agent.findOne({
        where: { publicId: forceAgentId },
      });

      const traceId = `trc_frc_${Date.now()}`;
      await saveTrace({
        traceId,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: forceAgentId,
        steps: [{ type: 'text-delta', text: 'hello' }],
      });
      const trace = await db.Trace.findOne({ where: { publicId: traceId } });

      const generationId = `gen_frc_${Date.now()}`;
      await db.Generation.create({
        publicId: generationId,
        projectId: project!.id as number,
        agentId: agent!.id as number,
        traceId: trace!.id as number,
        initiatorGenerationId: null,
        startedByActorId: null,
        startedByPrincipalType: null,
        startedByPrincipalId: null,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        lastActivityAt: new Date(),
        stopReason: 'stop',
        metadata: null,
      });

      const blockedResponse = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${forceAgentId}`
      );
      expect(blockedResponse.status).toBe(409);

      const forcedResponse = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${forceAgentId}?force=true`
      );
      expect(forcedResponse.status).toBe(204);

      expect(
        await db.Trace.findOne({ where: { publicId: traceId } })
      ).toBeNull();
      expect(
        await db.Generation.findOne({ where: { publicId: generationId } })
      ).toBeNull();
      expect(
        await db.Agent.findOne({ where: { publicId: forceAgentId } })
      ).toBeNull();
    });

    test('force=true preserves unrelated agents while nulling cross-agent trace/generation references', async () => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });

      const agentARes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Agent Force Parent',
        });
      const agentAId = agentARes.body.id as string;
      const agentA = await db.Agent.findOne({ where: { publicId: agentAId } });

      const agentBRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Agent Force Child',
        });
      const agentBId = agentBRes.body.id as string;
      const agentB = await db.Agent.findOne({ where: { publicId: agentBId } });

      const traceAId = `trc_frc_a_${Date.now()}`;
      await saveTrace({
        traceId: traceAId,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: agentAId,
        steps: [{ type: 'text-delta', text: 'parent' }],
      });
      const traceA = await db.Trace.findOne({ where: { publicId: traceAId } });

      const traceBId = `trc_frc_b_${Date.now()}`;
      await saveTrace({
        traceId: traceBId,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: agentBId,
        steps: [{ type: 'text-delta', text: 'child' }],
        parentTraceId: traceAId,
        rootTraceId: traceAId,
      });
      const traceB = await db.Trace.findOne({ where: { publicId: traceBId } });

      const generationAId = `gen_frc_a_${Date.now()}`;
      const generationA = await db.Generation.create({
        publicId: generationAId,
        projectId: project!.id as number,
        agentId: agentA!.id as number,
        traceId: traceA!.id as number,
        initiatorGenerationId: null,
        startedByActorId: null,
        startedByPrincipalType: null,
        startedByPrincipalId: null,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        lastActivityAt: new Date(),
        stopReason: 'stop',
        metadata: null,
      });

      const generationBId = `gen_frc_b_${Date.now()}`;
      await db.Generation.create({
        publicId: generationBId,
        projectId: project!.id as number,
        agentId: agentB!.id as number,
        traceId: traceB!.id as number,
        initiatorGenerationId: generationA.id as number,
        startedByActorId: null,
        startedByPrincipalType: null,
        startedByPrincipalId: null,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        lastActivityAt: new Date(),
        stopReason: 'stop',
        metadata: null,
      });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentAId}?force=true`
      );
      expect(response.status).toBe(204);

      expect(
        await db.Trace.findOne({ where: { publicId: traceAId } })
      ).toBeNull();
      expect(
        await db.Generation.findOne({ where: { publicId: generationAId } })
      ).toBeNull();

      const remainingTraceB = await db.Trace.findOne({
        where: { publicId: traceBId },
      });
      expect(remainingTraceB).not.toBeNull();
      expect(remainingTraceB!.parentTraceId).toBeNull();
      expect(remainingTraceB!.rootTraceId).toBeNull();

      const remainingGenerationB = await db.Generation.findOne({
        where: { publicId: generationBId },
      });
      expect(remainingGenerationB).not.toBeNull();
      expect(remainingGenerationB!.initiatorGenerationId).toBeNull();

      expect(
        await db.Agent.findOne({ where: { publicId: agentBId } })
      ).not.toBeNull();
    });
  });

  // ── Tool bindings ────────────────────────────────────────────────────────

  describe('tool_bindings', () => {
    let httpToolId: string;
    let clientToolId: string;

    beforeAll(async () => {
      const httpRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'bindings-http-tool',
          type: 'http',
          execute: { url: 'https://example.com/hook', method: 'POST' },
          parameters: {
            type: 'object',
            properties: { amount: { type: 'number' } },
          },
        });
      httpToolId = httpRes.body.id;

      const clientRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'bindings-client-tool',
          type: 'client',
          parameters: { type: 'object', properties: {} },
        });
      clientToolId = clientRes.body.id;
    });

    const createAgentWith = (body: Record<string, unknown>) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'bindings-agent',
          ...body,
        });
    };

    test('create with tool_bindings echoes canonical bindings and derived shorthands', async () => {
      const res = await createAgentWith({
        tool_bindings: [
          { tool_id: httpToolId },
          {
            tool: {
              name: 'inline-lookup',
              type: 'http',
              execute: { url: 'https://example.com/lookup' },
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.tool_bindings).toHaveLength(2);
      expect(res.body.tool_bindings[0].tool_id).toBe(httpToolId);
      expect(res.body.tool_bindings[1].tool.name).toBe('inline-lookup');
      // Deprecated shorthands stay echoed, derived from the bindings.
      expect(res.body.tool_ids).toEqual([httpToolId]);
      expect(res.body.tools).toHaveLength(1);
      expect(res.body.tools[0].name).toBe('inline-lookup');
    });

    test('a removed approval_policy field on a binding is rejected as unknown', async () => {
      // approval_policy was removed (breaking) — guardrails are the single
      // tool-call gating mechanism. The field is gone from the ToolBinding
      // schema, so the strict-fields validator rejects it as an unknown field.
      const res = await createAgentWith({
        tool_bindings: [
          {
            tool_id: httpToolId,
            approval_policy: { default: 'require_approval' },
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('mixing tool_bindings with tool_ids returns 400', async () => {
      const res = await createAgentWith({
        tool_bindings: [{ tool_id: httpToolId }],
        tool_ids: [httpToolId],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('mixing tool_bindings with tools returns 400', async () => {
      const res = await createAgentWith({
        tool_bindings: [{ tool_id: httpToolId }],
        tools: [{ name: 'x', type: 'http', execute: { url: 'https://e.co' } }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('binding entry with both tool_id and tool returns 400', async () => {
      const res = await createAgentWith({
        tool_bindings: [
          {
            tool_id: httpToolId,
            tool: {
              name: 'x',
              type: 'http',
              execute: { url: 'https://e.co' },
            },
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('binding entry with neither tool_id nor tool returns 400', async () => {
      const res = await createAgentWith({
        tool_bindings: [{}],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a client tool binding is accepted (no per-binding gate to reject it)', async () => {
      const res = await createAgentWith({
        tool_bindings: [{ tool_id: clientToolId }],
      });

      expect(res.status).toBe(201);
      expect(res.body.tool_bindings).toEqual([{ tool_id: clientToolId }]);
    });

    test('deprecated tool_ids write still works and derives tool_bindings', async () => {
      const res = await createAgentWith({ tool_ids: [httpToolId] });

      expect(res.status).toBe(201);
      expect(res.body.tool_ids).toEqual([httpToolId]);
      expect(res.body.tool_bindings).toEqual([{ tool_id: httpToolId }]);
    });

    test('updating via deprecated tool_ids replaces reference bindings, keeps inline ones', async () => {
      const createRes = await createAgentWith({
        tool_bindings: [
          { tool_id: httpToolId },
          {
            tool: {
              name: 'inline-keep',
              type: 'http',
              execute: { url: 'https://example.com/keep' },
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      });
      expect(createRes.status).toBe(201);

      const updateRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${createRes.body.id}`)
        .send({ tool_ids: [httpToolId] });

      expect(updateRes.status).toBe(200);
      const bindings = updateRes.body.tool_bindings;
      expect(bindings).toHaveLength(2);
      // Reference binding rewritten bare, inline kept.
      expect(bindings[0]).toEqual({ tool_id: httpToolId });
      expect(bindings[1].tool.name).toBe('inline-keep');
    });

    test('update with tool_bindings replaces the full list', async () => {
      const createRes = await createAgentWith({ tool_ids: [httpToolId] });
      expect(createRes.status).toBe(201);

      const updateRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${createRes.body.id}`)
        .send({
          tool_bindings: [{ tool_id: clientToolId }],
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.tool_bindings).toEqual([{ tool_id: clientToolId }]);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${createRes.body.id}`
      );
      expect(getRes.body.tool_bindings).toEqual([{ tool_id: clientToolId }]);
    });

    test('agent row created before tool_bindings existed still reads as bindings', async () => {
      // Pre-upgrade rows have only the legacy columns populated. Unreachable
      // through the API (which always writes toolBindings), so seed directly.
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const provider = await db.AiProvider.findOne({
        where: { publicId: aiProviderId },
      });
      const legacy = await db.Agent.create({
        projectId: project!.id,
        aiProviderId: provider!.id,
        name: 'legacy-agent',
        toolIds: [httpToolId],
        tools: [
          {
            name: 'legacy-inline',
            type: 'http',
            execute: { url: 'https://example.com/legacy' },
          },
        ],
      });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${legacy.publicId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.tool_bindings).toHaveLength(2);
      expect(res.body.tool_bindings[0]).toEqual({ tool_id: httpToolId });
      expect(res.body.tool_bindings[1].tool.name).toBe('legacy-inline');
      expect(res.body.tool_ids).toEqual([httpToolId]);
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

      // This suite doesn't run a real Ollama server (only the smoke/tutorials
      // CI jobs do), so the generation call deterministically either
      // succeeds (200, if a local Ollama happens to be reachable) or fails
      // upstream (502 AI_PROVIDER_ERROR) — never 400, which is what this
      // test actually cares about (toolContext was accepted as valid input).
      expect([200, 502]).toContain(response.status);
    });

    test('user without CreateAgentGeneration permission returns 404 (no accessible projects)', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      // noPermToken has no policies → projectIds=[] → agent not found in empty scope
      expect(response.status).toBe(404);
    });

    test('agent with knowledge_config injects knowledge context before generation', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Knowledge Agent',
          knowledge_config: {
            document_paths: ['/'],
            min_score: 0,
            limit: 3,
          },
        });
      expect(createRes.status).toBe(201);
      const knowledgeAgentId = createRes.body.id;
      expect(createRes.body.knowledge_config).toBeDefined();

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${knowledgeAgentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Tell me something' }] });

      // Knowledge search (embeddings) is mocked and always succeeds; only the
      // final Ollama generation call is real network I/O, which this suite
      // never has a live server for — so this deterministically resolves to
      // 200 or 502, matching the toolContext test's reasoning above.
      expect([200, 502]).toContain(genRes.status);
    });

    test('agent with write_memory_id in knowledge_config includes write_memory tool', async () => {
      // Create a memory to write to
      const memRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({ project_id: projectId, name: 'Agent Write Memory Test' });
      expect(memRes.status).toBe(201);
      const memoryId = memRes.body.id;

      // Create agent with write_memory_id in knowledge_config
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Write Memory Agent',
          knowledge_config: { write_memory_id: memoryId },
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.knowledge_config.write_memory_id).toBe(memoryId);
      const writeMemAgentId = createRes.body.id;

      // No live Ollama server in this suite — see the toolContext test above.
      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${writeMemAgentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
        });
      expect([200, 502]).toContain(genRes.status);
    });

    test('per-generation knowledge_config memory_ids is unioned with the agent stored config', async () => {
      const mockSearchKnowledge = jest.spyOn(
        knowledgeModule,
        'searchKnowledge'
      );
      mockSearchKnowledge.mockResolvedValueOnce([]);

      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Per-Generation Knowledge Agent',
          knowledge_config: { memory_ids: ['mem_agent_config'] },
        });
      expect(createRes.status).toBe(201);
      const knowledgeAgentId = createRes.body.id;

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${knowledgeAgentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Tell me something' }],
          knowledge_config: { memory_ids: ['mem_per_generation'] },
        });

      // No live Ollama server in this suite — see the toolContext test above.
      expect([200, 502]).toContain(genRes.status);
      expect(mockSearchKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryIds: expect.arrayContaining([
            'mem_agent_config',
            'mem_per_generation',
          ]),
        })
      );
      const callArgs = mockSearchKnowledge.mock.calls[0][0];
      expect(callArgs.memoryIds).toHaveLength(2);

      mockSearchKnowledge.mockRestore();
    });

    test('agent with output_schema runs a non-streaming generation', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Structured Output Agent',
          output_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        });
      expect(createRes.status).toBe(201);
      const structuredAgentId = createRes.body.id;

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${structuredAgentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Summarize this.' }] });

      // No live Ollama server in this suite — see the toolContext test above.
      expect([200, 502]).toContain(genRes.status);
    });

    test('agent with output_schema rejects stream:true with 400', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Structured Output Streaming Agent',
          output_schema: { type: 'object' },
        });
      expect(createRes.status).toBe(201);
      const structuredAgentId = createRes.body.id;

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${structuredAgentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(genRes.status).toBe(400);
      expect(genRes.body.error.code).toBe(
        'OUTPUT_SCHEMA_STREAMING_UNSUPPORTED'
      );
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

  // ── Actor linked to an agent (via POST /actors + agent_id) ─────────────
  // The former POST /agents/:id/actors was removed; an actor is now linked to
  // an agent by passing agent_id to the top-level /actors collection, and
  // listed back with the ?agent_id= filter.

  describe('actor ↔ agent link via /actors', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Actor Test Agent',
        });
      agentId = res.body.id;
    });

    test('creates an actor linked to the agent', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Test Actor for Agent',
          agent_id: agentId,
        });
      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Test Actor for Agent');
      expect(response.body.agent_id).toBe(agentId);
    });

    test('lists actors filtered by agent_id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/actors?project_id=${projectId}&agent_id=${agentId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(
        response.body.data.every((a: { agent_id: string }) => {
          return a.agent_id === agentId;
        })
      ).toBe(true);
    });

    test('unknown agent_id filter returns an empty page, not 404', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/actors?project_id=${projectId}&agent_id=agent_doesnotexist0`
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });
  });

  describe('reasoning removed (moved to Discussions)', () => {
    // The `reasoning` field no longer exists in the agent OpenAPI schema, so the
    // strict-fields middleware rejects it as an unknown field before the handler.
    test('rejects reasoning on agent create', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'no-reasoning',
          reasoning: { effort: 'high' },
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error)).toMatch(/reasoning/);
    });

    test('rejects reasoning on agent update', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'to-update',
        });
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ reasoning: { effort: 'low' } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error)).toMatch(/reasoning/);
    });

    test('rejects reasoning on a per-generation override', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'gen-agent',
        });
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${created.body.id}/generate`)
        .send({ prompt: 'hi', reasoning: { effort: 'high' } });
      expect(res.status).toBe(400);
    });
  });
});
