import fs from 'node:fs';

import { db } from 'src/db';
import * as agentNonStreamGenerationModule from 'src/lib/agentNonStreamGeneration';
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
        // A background generation hands back a generation id to poll, so the
        // generate tests need to read one back.
        'generations:GetGeneration',
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
        .query({ project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list agent tools', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/tools')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data[0].id).toMatch(/^tool_/);
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
          tool_bindings: [
            {
              tool: {
                name: 'inline-weather-tool',
                description: 'Gets the weather',
                execute: { url: 'https://example.com/weather' },
              },
            },
          ],
        });

      expect(response.status).toBe(201);
      expect(response.body.tool_bindings).toEqual([
        {
          tool: {
            name: 'inline-weather-tool',
            description: 'Gets the weather',
            execute: { url: 'https://example.com/weather' },
          },
        },
      ]);

      const toolsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/tools?project_id=${projectId}`
      );
      expect(
        (toolsRes.body.data as Array<{ name: string }>).some((t) => {
          return t.name === 'inline-weather-tool';
        })
      ).toBe(false);
    });

    test('one binding list carries reference and inline entries together', async () => {
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'preexisting-tool', project_id: projectId });
      const existingToolId = toolRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tool_bindings: [
            { tool_id: existingToolId },
            { tool: { name: 'inline-tool-merge' } },
          ],
        });

      expect(response.status).toBe(201);
      expect(response.body.tool_bindings).toEqual([
        { tool_id: existingToolId },
        { tool: { name: 'inline-tool-merge' } },
      ]);
    });

    test('rejects an ephemeral tool definition of type pipeline', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tool_bindings: [
            { tool: { name: 'inline-pipeline', type: 'pipeline' } },
          ],
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
          tool_bindings: [{ tool: { description: 'missing a name' } }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('non-object inline tool definition returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tool_bindings: [{ tool: 123 }],
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

    test('accepts an active_tool_ids entry naming a real tool in the project', async () => {
      const tool = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'active-tools-ok', type: 'http' });
      expect(tool.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tool_bindings: [{ tool_id: tool.body.id }],
          active_tool_ids: [tool.body.id],
        });

      expect(response.status).toBe(201);
      expect(response.body.active_tool_ids).toEqual([tool.body.id]);
    });

    test('rejects an active_tool_ids entry that names no tool in the project', async () => {
      // `active_tool_ids` is a declared reference (`x-soat-ref: tools`) and
      // narrows the agent's tool surface at generation time, so an unknown id
      // has to fail on write rather than silently disarm a tool (#811) — the
      // same contract `guardrail_ids` already had.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          active_tool_ids: ['tool_doesNotExist9999'],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
      expect(response.body.error.message).toMatch(/tool_doesNotExist9999/);
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
        .query({ project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list agents', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/agents')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data[0].id).toMatch(/^agent_/);
    });

    test('admin can list agents across all projects without a project_id filter', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/agents');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
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

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ name: 'renamed' });
      expect(response.status).toBe(403);
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

    test('can update agent with a reference binding', async () => {
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ name: 'tool-for-agent', project_id: projectId });
      const toolId = toolRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ tool_bindings: [{ tool_id: toolId }] });

      expect(response.status).toBe(200);
      expect(response.body.tool_bindings).toEqual([{ tool_id: toolId }]);
    });

    test('non-array tool_bindings returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ tool_bindings: 'not-an-array' });

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
        .send({ tool_bindings: [{ tool: { name: 'inline-tool-on-update' } }] });

      expect(response.status).toBe(200);
      expect(response.body.tool_bindings).toEqual([
        { tool: { name: 'inline-tool-on-update' } },
      ]);
    });

    test('can clear tool_bindings by setting it to null', async () => {
      const freshAgentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          tool_bindings: [{ tool: { name: 'to-be-cleared' } }],
        });
      const freshAgentId = freshAgentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${freshAgentId}`)
        .send({ tool_bindings: null });

      expect(response.status).toBe(200);
      expect(response.body.tool_bindings).toBeNull();
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

    // The bug #1029 opened with: this answered 404 while the caller's own
    // `GET /agents/:id` answered 200 for the same agent at the same instant.
    test('user without permission returns 403, not 404', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: 'x' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
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

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/agents/${agentId}`
      );
      expect(response.status).toBe(403);
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
        generationId: 'gen_test_steps',
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
        generationId: 'gen_test_steps',
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
        generationId: 'gen_test_steps',
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

    test('force=true removes the trace file row and its storage object', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'Agent Force Delete Storage',
        });
      const forceAgentId = createRes.body.id as string;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });

      const traceId = `trc_frc_storage_${Date.now()}`;
      await saveTrace({
        traceId,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: forceAgentId,
        generationId: 'gen_test_steps',
        steps: [{ type: 'text-delta', text: 'hello' }],
      });
      const trace = await db.Trace.findOne({ where: { publicId: traceId } });
      const file = await db.File.findOne({
        where: { id: trace!.fileId as number },
      });
      const storagePath = file!.storagePath;

      expect(fs.existsSync(storagePath)).toBe(true);

      const forcedResponse = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${forceAgentId}?force=true`
      );
      expect(forcedResponse.status).toBe(204);

      expect(
        await db.File.findOne({ where: { id: file!.id as number } })
      ).toBeNull();
      expect(fs.existsSync(storagePath)).toBe(false);
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
        generationId: 'gen_test_steps',
        steps: [{ type: 'text-delta', text: 'parent' }],
      });
      const traceA = await db.Trace.findOne({ where: { publicId: traceAId } });

      const traceBId = `trc_frc_b_${Date.now()}`;
      await saveTrace({
        traceId: traceBId,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: agentBId,
        generationId: 'gen_test_steps',
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

    test('create with tool_bindings echoes the canonical bindings', async () => {
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
      // `tool_bindings` is the only attachment field on the wire — the
      // `tool_ids`/`tools` shorthands were removed for v1.
      expect(res.body.tool_ids).toBeUndefined();
      expect(res.body.tools).toBeUndefined();
    });

    // An inline binding's tool must be converted between the wire's snake_case
    // and the camelCase every consumer reads. Storing the wire object verbatim
    // made `denied_actions` deny nothing and dropped the other fields silently.
    test('an inline binding tool round-trips denied_actions/preset_parameters/output_mapping', async () => {
      const res = await createAgentWith({
        tool_bindings: [
          {
            tool: {
              name: 'inline-gated',
              type: 'builtin',
              actions: ['list-documents', 'get-document'],
              denied_actions: ['get-document'],
              preset_parameters: { project_id: projectId },
              output_mapping: { result: '$.data' },
            },
          },
        ],
      });

      expect(res.status).toBe(201);
      const tool = res.body.tool_bindings[0].tool;
      expect(tool.denied_actions).toEqual(['get-document']);
      expect(tool.preset_parameters).toEqual({ project_id: projectId });
      expect(tool.output_mapping).toEqual({ result: '$.data' });

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${res.body.id}`
      );
      const roundTripped = getRes.body.tool_bindings[0].tool;
      expect(roundTripped.denied_actions).toEqual(['get-document']);
      expect(roundTripped.preset_parameters).toEqual({
        project_id: projectId,
      });
      expect(roundTripped.output_mapping).toEqual({ result: '$.data' });
    });

    test('an unknown field on a binding is rejected', async () => {
      // A binding carries only tool_id / tool; the strict-fields validator
      // rejects any unknown field at the binding level.
      const res = await createAgentWith({
        tool_bindings: [{ tool_id: httpToolId, bogus_field: true }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    // fromWireInlineTool (agentToolBindings.ts) converts a binding's inline
    // `tool` before validation runs, so a non-object `tool` must pass through
    // untouched instead of throwing — validateInlineBindingTool's own
    // isPlainObject check is what actually rejects it with a clear message.
    test('a non-object inline tool is rejected by validation, not the converter', async () => {
      const res = await createAgentWith({
        tool_bindings: [{ tool: 'not-an-object' }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an explicit null tool_bindings clears any existing bindings', async () => {
      const created = await createAgentWith({
        tool_bindings: [{ tool_id: httpToolId }],
      });

      const updateRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ tool_bindings: null });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.tool_bindings).toBeNull();
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

    // The `tool_ids` / `tools` shorthands were removed for v1. They are no
    // longer in the OpenAPI specs, so `strictFields` rejects them as unknown
    // fields — one deterministic check covering REST, the SDK, the CLI and the
    // MCP tool surface at once.
    test('create rejects the removed `tool_ids` field', async () => {
      const res = await createAgentWith({ tool_ids: [httpToolId] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('create rejects the removed `tools` field', async () => {
      const res = await createAgentWith({
        tools: [
          {
            name: 'inline-removed',
            type: 'http',
            execute: { url: 'https://example.com/removed' },
            parameters: { type: 'object', properties: {} },
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test.each([['tool_ids'], ['tools']])(
      'update rejects the removed `%s` field',
      async (field) => {
        const createRes = await createAgentWith({
          tool_bindings: [{ tool_id: httpToolId }],
        });
        expect(createRes.status).toBe(201);

        const updateRes = await authenticatedTestClient(userToken)
          .patch(`/api/v1/agents/${createRes.body.id}`)
          .send({ [field]: field === 'tool_ids' ? [httpToolId] : [] });

        expect(updateRes.status).toBe(400);
        expect(updateRes.body.error.code).toBe('VALIDATION_FAILED');
        // The removed field must not have mutated the agent on its way out.
        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/agents/${createRes.body.id}`
        );
        expect(getRes.body.tool_bindings).toEqual([{ tool_id: httpToolId }]);
      }
    );

    test('update with tool_bindings replaces the full list', async () => {
      const createRes = await createAgentWith({
        tool_bindings: [{ tool_id: httpToolId }],
      });
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
  });

  // ── Generation ───────────────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/generate?wait=true', () => {
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
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(401);
    });

    test('missing messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty messages array returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('unknown agentId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/agt_doesnotexist0000/generate?wait=true')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('accepts toolContext in request body', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          tool_context: { user_id: 'u1', env: 'test' },
        });

      // No Ollama here, so the call either succeeds or fails upstream — never
      // 400, which is what this asserts: `toolContext` was accepted as input.
      expect([200, 502]).toContain(response.status);
    });

    test('background by default: returns 202 with a pollable generation handle', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(202);
      expect(response.body.status).toBe('accepted');
      expect(response.body.generation_id).toBeDefined();
      expect(response.body.trace_id).toBeDefined();

      // The handle must be usable: the generation record is written before the
      // response, so a caller can poll it without racing the dispatch.
      const poll = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${response.body.generation_id}`
      );
      expect(poll.status).toBe(200);
      expect(poll.body.id).toBe(response.body.generation_id);
    });

    test('a background generation that fails records the failure for polling', async () => {
      // Sanctioned force-failure stub: no real provider call fails
      // deterministically, and the background path's swallow-and-record branch
      // is unreachable otherwise. The happy path above uses the real pipeline.
      jest
        .spyOn(agentNonStreamGenerationModule, 'runNonStreamGeneration')
        .mockRejectedValueOnce(new Error('provider exploded'));

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(202);
      const generationId = response.body.generation_id;

      // The whole point of the background mode: a failure after admission is
      // discoverable by polling rather than lost with the request.
      let status: string | undefined;
      for (let attempt = 0; attempt < 50 && status !== 'failed'; attempt += 1) {
        const poll = await authenticatedTestClient(userToken).get(
          `/api/v1/generations/${generationId}`
        );
        status = poll.body.status;
      }

      expect(status).toBe('failed');

      jest.restoreAllMocks();
    });

    test('background mode still rejects an invalid body synchronously', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [] });

      expect(response.status).toBe(400);
    });

    test('stream with wait=false is rejected as contradictory', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=false`)
        .send({ messages: [{ role: 'user', content: 'Hello' }], stream: true });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('user without CreateAgentGeneration permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      // noPermToken has no policies → projectIds=[] → refused outright, before
      // the agent lookup that used to turn the denial into a 404 (#1029).
      expect(response.status).toBe(403);
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
        .post(`/api/v1/agents/${knowledgeAgentId}/generate?wait=true`)
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
        .post(`/api/v1/agents/${writeMemAgentId}/generate?wait=true`)
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
        .post(`/api/v1/agents/${knowledgeAgentId}/generate?wait=true`)
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
        .post(`/api/v1/agents/${structuredAgentId}/generate?wait=true`)
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
        .post(`/api/v1/agents/${structuredAgentId}/generate?wait=true`)
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
          tool_outputs: [{ tool_call_id: 'tc_1', output: 'result' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('user without CreateAgentGeneration permission on tool-outputs returns 403', async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const agentId = agentRes.body.id;

      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_fake/tool-outputs`)
        .send({
          tool_outputs: [{ tool_call_id: 'tc_1', output: 'result' }],
        });

      // noPermToken has no policies → projectIds=[] → refused outright, before
      // the agent lookup that used to turn the denial into a 404 (#1029).
      expect(response.status).toBe(403);
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

  describe('reasoning config removed', () => {
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
        .post(`/api/v1/agents/${created.body.id}/generate?wait=true`)
        .send({ prompt: 'hi', reasoning: { effort: 'high' } });
      expect(res.status).toBe(400);
    });
  });
  describe('stop_conditions validation', () => {
    const create = (stop_conditions: unknown) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: `stopcond-${Math.random().toString(36).slice(2, 8)}`,
          stop_conditions,
        });
    };

    test('accepts the documented hasToolCall condition', async () => {
      const res = await create([{ type: 'hasToolCall', tool_name: 'done' }]);

      expect(res.status).toBe(201);
      expect(res.body.stop_conditions).toEqual([
        { type: 'hasToolCall', tool_name: 'done' },
      ]);
    });

    test('accepts the chain-scoped maxChainGenerations condition', async () => {
      const res = await create([
        { type: 'maxChainGenerations', max_generations: 20 },
      ]);

      expect(res.status).toBe(201);
      expect(res.body.stop_conditions).toEqual([
        { type: 'maxChainGenerations', max_generations: 20 },
      ]);
    });

    test('rejects maxChainGenerations without a positive max_generations', async () => {
      // A ceiling of 0 or a missing number would be stored and then read as "no
      // agent ceiling", i.e. silently fall back to the platform's — which is the
      // opposite of what the author asked for.
      for (const condition of [
        { type: 'maxChainGenerations' },
        { type: 'maxChainGenerations', max_generations: 0 },
        { type: 'maxChainGenerations', max_generations: 1.5 },
        { type: 'maxChainGenerations', max_generations: '10' },
      ]) {
        const res = await create([condition]);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    test('rejects an unknown condition type', async () => {
      // The field used to accept anything and enforce nothing. A typo now fails
      // the write instead of reading as a condition that never fires.
      const res = await create([{ type: 'hasToolcall', tool_name: 'done' }]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a hasToolCall condition with no tool_name', async () => {
      const res = await create([{ type: 'hasToolCall' }]);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a non-object entry', async () => {
      const res = await create(['done']);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a value that is not an array', async () => {
      const res = await create('done');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an update is validated on the same path', async () => {
      const created = await create(null);
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ stop_conditions: [{ type: 'whenever' }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('a forcing tool_choice requires a way to stop', () => {
    const DONE: object = { type: 'hasToolCall', tool_name: 'done' };

    const createAgentWith = (body: Record<string, unknown>) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: `forced-${Math.random().toString(36).slice(2, 8)}`,
          ...body,
        });
    };

    // `"required"` forbids a final assistant message on every step, so an agent
    // that declares no terminal condition can only ever end a turn by
    // exhausting `max_steps` — including the continuation that carries an
    // approval decision back to it, which then reports nothing.
    test('rejects "required" with no stop condition', async () => {
      const res = await createAgentWith({ tool_choice: 'required' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORCED_TOOL_CHOICE_CANNOT_STOP');
    });

    test('rejects a named tool with no stop condition', async () => {
      const res = await createAgentWith({
        tool_choice: { type: 'tool', tool_name: 'search' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORCED_TOOL_CHOICE_CANNOT_STOP');
    });

    // Chain-scoped: it caps how many generations a chain spawns, it never ends a
    // turn, so it is not the exit this rule is about.
    test('rejects "required" when only maxChainGenerations is declared', async () => {
      const res = await createAgentWith({
        tool_choice: 'required',
        stop_conditions: [{ type: 'maxChainGenerations', max_generations: 20 }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORCED_TOOL_CHOICE_CANNOT_STOP');
    });

    test('accepts "required" with a hasToolCall condition', async () => {
      const res = await createAgentWith({
        tool_choice: 'required',
        stop_conditions: [DONE],
      });

      expect(res.status).toBe(201);
      expect(res.body.tool_choice).toBe('required');
    });

    test('leaves a non-forcing tool_choice alone', async () => {
      for (const tool_choice of ['auto', 'none', null]) {
        const res = await createAgentWith({ tool_choice });
        expect(res.status).toBe(201);
      }
    });

    test('rejects introducing forcing on an agent that cannot stop', async () => {
      const created = await createAgentWith({ tool_choice: 'auto' });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ tool_choice: 'required' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORCED_TOOL_CHOICE_CANNOT_STOP');
    });

    // The rule is evaluated against the config the write would *leave behind*,
    // so removing the exit is refused just as introducing the forcing is. A
    // per-field check would pass this: the body names no tool_choice at all.
    test('rejects removing the stop condition from a forcing agent', async () => {
      const created = await createAgentWith({
        tool_choice: 'required',
        stop_conditions: [DONE],
      });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ stop_conditions: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORCED_TOOL_CHOICE_CANNOT_STOP');
    });

    test('accepts forcing added to an agent that already declares an exit', async () => {
      const created = await createAgentWith({ stop_conditions: [DONE] });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ tool_choice: 'required' });

      expect(res.status).toBe(200);
      expect(res.body.tool_choice).toBe('required');
    });

    test('clearing a forcing tool_choice needs no stop condition', async () => {
      const created = await createAgentWith({
        tool_choice: 'required',
        stop_conditions: [DONE],
      });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ tool_choice: null, stop_conditions: [] });

      expect(res.status).toBe(200);
      expect(res.body.tool_choice).toBeNull();
    });
  });

  describe('on_approval_expiry', () => {
    test('defaults to null — an expired approval ends the chain', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'expiry-default',
        });

      expect(res.status).toBe(201);
      expect(res.body.on_approval_expiry).toBeNull();
    });

    test('an agent can opt into reacting to an expiry', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'expiry-react',
          on_approval_expiry: 'react',
        });

      expect(res.status).toBe(201);
      expect(res.body.on_approval_expiry).toBe('react');

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${res.body.id}`
      );
      expect(read.body.on_approval_expiry).toBe('react');
    });

    test('an existing agent can be switched by update', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'expiry-to-switch',
        });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ on_approval_expiry: 'react' });

      expect(res.status).toBe(200);
      expect(res.body.on_approval_expiry).toBe('react');

      // And back — clearing it returns the agent to the terminating default
      // rather than leaving the opt-in stuck on.
      const cleared = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ on_approval_expiry: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body.on_approval_expiry).toBeNull();
    });

    test('rejects a non-string value with 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'expiry-number',
          on_approval_expiry: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects an unknown value with 400', async () => {
      // A typo must not read as the safe default at resume time.
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'expiry-bogus',
          on_approval_expiry: 'continue',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('trace_content_mode (zero-retention)', () => {
    test('defaults to null — the agent inherits its project', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'zr-default',
        });

      expect(res.status).toBe(201);
      expect(res.body.trace_content_mode).toBeNull();
    });

    test('an agent can tighten a storing project to none', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'zr-tightened',
          trace_content_mode: 'none',
        });

      expect(res.status).toBe(201);
      expect(res.body.trace_content_mode).toBe('none');
    });

    test('an existing agent can be tightened by update', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'zr-to-tighten',
        });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${created.body.id}`)
        .send({ trace_content_mode: 'none' });

      expect(res.status).toBe(200);
      expect(res.body.trace_content_mode).toBe('none');
    });

    test('rejects an unknown mode with 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'zr-bogus',
          trace_content_mode: 'partial',
        });

      expect(res.status).toBe(400);
    });

    test('an agent cannot loosen a zero-retention project back to full', async () => {
      // The project is a floor. Without this, a project-wide zero-retention
      // mandate could be escaped simply by creating another agent under it.
      const zeroProject = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Agent ZR Floor Project' });
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${zeroProject.body.id}`)
        .send({ trace_content_mode: 'none' });

      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: zeroProject.body.id,
          name: 'ZR Floor Provider',
          provider: 'openai',
          default_model: 'gpt-4o-mini',
        });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: zeroProject.body.id,
          ai_provider_id: provider.body.id,
          name: 'zr-escapee',
          trace_content_mode: 'full',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/cannot store content/i);
    });
  });

  describe('boundary_policy action validation', () => {
    // A boundary is the one policy surface where a mis-named action fails
    // *open*: `Deny` on a typo matches nothing, so the agent stays permitted.
    // Only the formation path used to run this check, so a typo written
    // through REST was stored unchecked (#1070).
    test('rejects a create whose boundary_policy names an unknown action', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'typo-boundary-agent',
          boundary_policy: {
            statement: [
              {
                effect: 'Deny',
                action: ['documents:GetDocumnet'],
                resource: ['*'],
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/documents:GetDocumnet/);
      expect(res.body.error.message).toMatch(/not a known action/i);
    });

    test('rejects an update whose boundary_policy names an unknown action', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'boundary-update-agent',
        });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/agents/${created.body.id}`)
        .send({
          boundary_policy: {
            statement: [
              {
                effect: 'Allow',
                action: ['agents:NotAThing'],
                resource: ['*'],
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/agents:NotAThing/);
    });

    test('accepts a boundary_policy built from real actions', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'valid-boundary-agent',
          boundary_policy: {
            statement: [
              {
                effect: 'Allow',
                action: ['documents:GetDocument', 'documents:*'],
                resource: ['*'],
              },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.boundary_policy.statement[0].action).toEqual([
        'documents:GetDocument',
        'documents:*',
      ]);
    });
  });
});
