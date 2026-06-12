import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Reasoning config', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'reasoningadmin', password: 'supersecret' });

    adminToken = await loginAs('reasoningadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Reasoning Test Project' });
    projectId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'ReasoningProvider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('agent reasoning contract', () => {
    test('agent create round-trips the reasoning config', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'ReasoningContractAgent',
          reasoning: {
            effort: 'high',
            mode: 'reflect',
            critique: {
              ai_provider_id: aiProviderId,
              model: 'critique-model',
              prompt: 'Focus on factual accuracy.',
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.reasoning.effort).toBe('high');
      expect(res.body.reasoning.mode).toBe('reflect');
      expect(res.body.reasoning.critique.ai_provider_id).toBe(aiProviderId);
      expect(res.body.reasoning.critique.model).toBe('critique-model');
      expect(res.body.reasoning.critique.prompt).toBe(
        'Focus on factual accuracy.'
      );
    });

    test('agent update sets and clears the reasoning config', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'ReasoningUpdateAgent',
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.reasoning ?? null).toBeNull();
      const agentId = createRes.body.id;

      const updateRes = await authenticatedTestClient(adminToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ reasoning: { mode: 'reflect' } });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.reasoning.mode).toBe('reflect');

      const clearRes = await authenticatedTestClient(adminToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ reasoning: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.reasoning ?? null).toBeNull();
    });
  });

  describe('debate config round-trip', () => {
    test('agent create round-trips integer perspectives and synthesis override', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'DebateContractAgent',
          reasoning: {
            mode: 'debate',
            perspectives: 2,
            max_rounds: 1,
            synthesis: {
              ai_provider_id: aiProviderId,
              model: 'synth-model',
              prompt: 'Weigh the arguments and commit.',
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.reasoning.mode).toBe('debate');
      expect(res.body.reasoning.perspectives).toBe(2);
      expect(res.body.reasoning.max_rounds).toBe(1);
      expect(res.body.reasoning.synthesis.ai_provider_id).toBe(aiProviderId);
      expect(res.body.reasoning.synthesis.model).toBe('synth-model');
      expect(res.body.reasoning.synthesis.prompt).toBe(
        'Weigh the arguments and commit.'
      );
    });

    test('agent create round-trips explicit perspective objects', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'HeterogeneousDebateAgent',
          reasoning: {
            mode: 'debate',
            perspectives: [
              {
                name: 'Skeptic',
                prompt: 'Find the fatal flaw.',
                ai_provider_id: aiProviderId,
                model: 'skeptic-model',
              },
              { name: 'Advocate' },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.reasoning.mode).toBe('debate');
      expect(Array.isArray(res.body.reasoning.perspectives)).toBe(true);
      expect(res.body.reasoning.perspectives).toHaveLength(2);
      expect(res.body.reasoning.perspectives[0].name).toBe('Skeptic');
      expect(res.body.reasoning.perspectives[0].prompt).toBe(
        'Find the fatal flaw.'
      );
      expect(res.body.reasoning.perspectives[0].ai_provider_id).toBe(
        aiProviderId
      );
      expect(res.body.reasoning.perspectives[0].model).toBe('skeptic-model');
      expect(res.body.reasoning.perspectives[1].name).toBe('Advocate');
    });
  });

  describe('per-generate reasoning override', () => {
    test('generate route forwards the reasoning override to the pipeline', async () => {
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'ReasoningOverrideAgent',
        });
      const agentId = agentRes.body.id;

      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_reason_1',
        traceId: 'trc_reason_1',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Deeply considered answer.',
          finishReason: 'stop',
        },
      });

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Hard question.' }],
          reasoning: { mode: 'reflect', effort: 'high' },
        });

      expect(res.status).toBe(200);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      const callArgs = mockCreateGeneration.mock.calls[0][0];
      expect(callArgs.reasoning).toEqual({ mode: 'reflect', effort: 'high' });
    });
  });
});
