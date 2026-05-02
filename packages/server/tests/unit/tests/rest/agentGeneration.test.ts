import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Agent Generation Routes', () => {
  test('POST /api/v1/agents/:id/generate returns 401 when unauthenticated', async () => {
    const response = await testClient
      .post('/api/v1/agents/agent_test_id/generate')
      .send({ messages: [{ role: 'user', content: 'hello' }] });

    expect(response.status).toBe(401);
  });

  test('POST /api/v1/agents/:id/generate/:gen_id/tool-outputs returns 401 when unauthenticated', async () => {
    const response = await testClient
      .post('/api/v1/agents/agent_test_id/generate/gen_test_id/tool-outputs')
      .send({
        toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
      });

    expect(response.status).toBe(401);
  });

  describe('ai_provider_not_found branch', () => {
    let adminToken: string;
    let userToken: string;
    let agentId: string;

    beforeAll(async () => {
      await testClient
        .post('/api/v1/users/bootstrap')
        .send({ username: 'agentgeneradmin', password: 'supersecret' });
      adminToken = await loginAs('agentgeneradmin', 'supersecret');

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'agentgeneruser', password: 'agentgenerpass' });
      userToken = await loginAs('agentgeneruser', 'agentgenerpass');
      const userId = userRes.body.id;

      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'AgentGeneration Test Project' });
      const projectId = projectRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['agents:CreateAgent', 'agents:CreateAgentGeneration'],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Gen Test Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });

      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProvRes.body.id,
          project_id: projectId,
          name: 'Gen Test Agent',
        });
      agentId = agentRes.body.id;
    });

    test('returns 404 when ai provider is not found', async () => {
      mockCreateGeneration.mockResolvedValueOnce('ai_provider_not_found');
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });
  });
});
