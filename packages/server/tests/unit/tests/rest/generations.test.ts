import { updateGenerationRecord } from 'src/lib/generations';

import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Covers issue #179 — error surfacing on generation failure:
 * - upstream provider errors are mapped to 502 AI_PROVIDER_ERROR
 * - failed generations are persisted with status 'failed' and an error payload
 * - traces record the error of failed generations
 * - GET /api/v1/generations/:generation_id exposes generation records
 */
describe('Generations', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let agentId: string;
  let failedGenerationId: string;
  let failedTraceId: string;

  beforeAll(async () => {
    const bootstrapRes = await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'generationsadmin', password: 'supersecret' });

    if (bootstrapRes.status === 201) {
      adminToken = await loginAs('generationsadmin', 'supersecret');
    } else {
      adminToken = await loginAs('admin', 'supersecret');
    }

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'generationsuser', password: 'generationspass' });
    userToken = await loginAs('generationsuser', 'generationspass');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'generationsnoperm', password: 'generationsnopass' });
    noPermToken = await loginAs('generationsnoperm', 'generationsnopass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Generations Test Project' });
    const projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agents:CreateAgent',
                'agents:CreateAgentGeneration',
                'generations:GetGeneration',
                'generations:ListGenerations',
                'traces:GetTrace',
              ],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    // Provider pointing at an unreachable endpoint so a real generation
    // attempt fails with an upstream provider (API call) error.
    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Unreachable Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
        base_url: 'http://127.0.0.1:9/v1',
      });

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProvRes.body.id,
        project_id: projectId,
        name: 'Generations Failing Agent',
      });
    agentId = agentRes.body.id;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('provider failure surfacing on POST /api/v1/agents/:agent_id/generate', () => {
    test('returns 502 AI_PROVIDER_ERROR with generation and trace IDs in meta', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('AI_PROVIDER_ERROR');
      expect(response.body.error.message).toBeDefined();
      expect(response.body.error.meta.generation_id).toBeDefined();
      expect(response.body.error.meta.trace_id).toBeDefined();

      failedGenerationId = response.body.error.meta.generation_id;
      failedTraceId = response.body.error.meta.trace_id;
    }, 60000);

    test('persists the failed generation with status failed and an error payload', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(failedGenerationId);
      expect(response.body.status).toBe('failed');
      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toBeDefined();
      expect(response.body.trace_id).toBe(failedTraceId);
      expect(response.body.agent_id).toBe(agentId);
      expect(response.body.completed_at).toBeDefined();
    });

    test('records the error on the trace', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${failedTraceId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toBeDefined();
    });
  });

  describe('requires_action tool call arg casing on POST /generate', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    // A client tool's `args` mirror the caller-authored `parameters` JSON
    // Schema, which is stored and returned verbatim (e.g. camelCase). The
    // requires_action payload must return those keys unchanged — the outbound
    // caseTransform must not snake_case them, or the payload diverges from the
    // schema the caller owns.
    test('preserves the authored casing of tool call args', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_argcase_01',
        traceId: 'trc_argcase_01',
        status: 'requires_action',
        requiredAction: {
          type: 'submit_tool_outputs' as const,
          toolCalls: [
            {
              id: 'tc_argcase_01',
              toolName: 'createOptimization',
              args: {
                adAccountId: 'act_123',
                campaignId: 'cmp_456',
                input: 'single-word-key',
              },
            },
          ],
        },
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'optimize my ads' }] });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('requires_action');

      const toolCall = response.body.required_action.tool_calls[0];
      expect(toolCall.args.adAccountId).toBe('act_123');
      expect(toolCall.args.campaignId).toBe('cmp_456');
      expect(toolCall.args.input).toBe('single-word-key');

      // The snake_cased forms must NOT appear — the middleware must leave the
      // caller-authored keys untouched.
      expect(toolCall.args.ad_account_id).toBeUndefined();
      expect(toolCall.args.campaign_id).toBeUndefined();
    });
  });

  describe('GET /api/v1/generations', () => {
    test('returns 401 when unauthenticated', async () => {
      const response = await testClient.get('/api/v1/generations');
      expect(response.status).toBe(401);
    });

    test('returns 403 when user lacks permission', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        '/api/v1/generations'
      );
      expect(response.status).toBe(403);
    });

    test('lists generations filtered by agent_id', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?agent_id=${agentId}`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.total).toBeGreaterThanOrEqual(1);
      for (const gen of response.body.data) {
        expect(gen.agent_id).toBe(agentId);
      }
    });

    test('unknown agent_id filter returns an empty page', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/generations?agent_id=agent_doesnotexist0'
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    test('accepts limit and offset query params', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?agent_id=${agentId}&limit=1&offset=0`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('admin without project scoping lists across all projects', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations?agent_id=${agentId}`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/generations/:generation_id', () => {
    test('returns 401 when unauthenticated', async () => {
      const response = await testClient.get('/api/v1/generations/gen_x');
      expect(response.status).toBe(401);
    });

    test('returns 403 when user lacks permission', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );
      expect(response.status).toBe(403);
    });

    test('returns 404 when generation does not exist', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/generations/gen_does_not_exist'
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('does not expose internal numeric IDs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(typeof response.body.project_id).toBe('string');
    });

    test('exposes metadata.extraction but strips internal pendingState', async () => {
      await updateGenerationRecord({
        publicId: failedGenerationId,
        metadata: {
          pendingState: {
            messages: [{ role: 'user', content: 'secret internal message' }],
          },
          extraction: {
            candidates: 2,
            created: 1,
            updated: 0,
            skipped: 1,
          },
        },
      });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.metadata.extraction).toEqual({
        candidates: 2,
        created: 1,
        updated: 0,
        skipped: 1,
      });
      expect(response.body.metadata.pendingState).toBeUndefined();
    });
  });
});
