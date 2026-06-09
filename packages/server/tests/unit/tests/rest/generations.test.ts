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

    test('does not expose internal metadata or numeric IDs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.metadata).toBeUndefined();
      expect(typeof response.body.project_id).toBe('string');
    });
  });
});
