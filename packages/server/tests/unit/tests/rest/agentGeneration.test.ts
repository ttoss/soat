import * as agentsModule from 'src/lib/agents';

import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Agent Generation Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

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

  describe('validation and error branches', () => {
    let adminToken: string;
    let userToken: string;
    let noPermToken: string;
    let agentId: string;

    beforeAll(async () => {
      const bootstrapRes = await testClient
        .post('/api/v1/users/bootstrap')
        .send({ username: 'agentvalidadmin', password: 'supersecret' });

      // Bootstrap can run only once in the test DB. If it already ran in
      // another describe, reuse that admin account for setup.
      if (bootstrapRes.status === 201) {
        adminToken = await loginAs('agentvalidadmin', 'supersecret');
      } else {
        adminToken = await loginAs('agentgeneradmin', 'supersecret');
      }

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'agentvaliduser', password: 'agentvalidpass' });
      userToken = await loginAs('agentvaliduser', 'agentvalidpass');

      await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'agentvalidnoperm', password: 'agentnopass' });
      noPermToken = await loginAs('agentvalidnoperm', 'agentnopass');

      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'AgentGeneration Validation Project' });
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
        .put(`/api/v1/users/${userRes.body.id}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Validation Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });

      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProvRes.body.id,
          project_id: projectId,
          name: 'Validation Agent',
        });
      agentId = agentRes.body.id;
    });

    test('returns 400 when messages is missing or empty', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [] });

      expect(response.status).toBe(400);
    });

    test('returns 404 when user cannot access target agent', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(404);
    });

    test('returns 500 when createGeneration throws', async () => {
      mockCreateGeneration.mockRejectedValueOnce(new Error('boom'));

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('boom');
    });

    test('tool-outputs returns 400 when payload is missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_x/tool-outputs`)
        .send({ toolOutputs: [] });

      expect(response.status).toBe(400);
    });

    test('tool-outputs returns 404 when generation is not found', async () => {
      jest
        .spyOn(agentsModule, 'submitToolOutputs')
        .mockResolvedValueOnce('generation_not_found');

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_x/tool-outputs`)
        .send({ toolOutputs: [{ tool_call_id: 'tc_1', output: 'ok' }] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Generation not found');
    });

    test('tool-outputs returns 404 when agent is not found', async () => {
      jest
        .spyOn(agentsModule, 'submitToolOutputs')
        .mockResolvedValueOnce('not_found');

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_x/tool-outputs`)
        .send({ toolOutputs: [{ tool_call_id: 'tc_1', output: 'ok' }] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent not found');
    });

    test('tool-outputs returns 200 with result on success', async () => {
      const mockResult = {
        id: 'gen_ok',
        traceId: 'trc_ok',
        status: 'completed',
        output: { model: 'test-model', content: 'done', finishReason: 'stop' },
      };
      jest
        .spyOn(agentsModule, 'submitToolOutputs')
        .mockResolvedValueOnce(mockResult as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate/gen_x/tool-outputs`)
        .send({ toolOutputs: [{ tool_call_id: 'tc_1', output: 'result' }] });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('gen_ok');
    });
  });
});
