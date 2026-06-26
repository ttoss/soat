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

  describe('agent pipeline contract', () => {
    test('agent create round-trips a pipeline config', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'PipelineContractAgent',
          reasoning: {
            effort: 'high',
            mode: 'pipeline',
            steps: [
              {
                name: 'critique',
                prompt: 'Critique: {draft}',
                ai_provider_id: aiProviderId,
                model: 'critique-model',
                halt_if_equals: 'APPROVED',
              },
              {
                name: 'final',
                prompt: 'Improve using {steps.critique}',
                output: true,
              },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.reasoning.effort).toBe('high');
      expect(res.body.reasoning.mode).toBe('pipeline');
      expect(res.body.reasoning.steps).toHaveLength(2);
      expect(res.body.reasoning.steps[0].name).toBe('critique');
      expect(res.body.reasoning.steps[0].ai_provider_id).toBe(aiProviderId);
      expect(res.body.reasoning.steps[0].model).toBe('critique-model');
      expect(res.body.reasoning.steps[0].halt_if_equals).toBe('APPROVED');
      expect(res.body.reasoning.steps[1].output).toBe(true);
    });

    test('agent create round-trips a fanout step', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'FanoutContractAgent',
          reasoning: {
            mode: 'pipeline',
            steps: [
              {
                kind: 'fanout',
                name: 'angles',
                perspectives: [
                  { name: 'Skeptic', prompt: 'Find the flaw.' },
                  { name: 'Advocate' },
                ],
                prompt: 'Argue an angle on {question}',
              },
              {
                name: 'final',
                prompt: 'Reconcile {steps.angles}',
                output: true,
              },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.reasoning.steps[0].kind).toBe('fanout');
      expect(res.body.reasoning.steps[0].perspectives).toHaveLength(2);
      expect(res.body.reasoning.steps[0].perspectives[0].name).toBe('Skeptic');
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
        .send({
          reasoning: {
            mode: 'pipeline',
            steps: [{ name: 'final', prompt: 'Refine: {draft}', output: true }],
          },
        });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.reasoning.mode).toBe('pipeline');

      const clearRes = await authenticatedTestClient(adminToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({ reasoning: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.reasoning ?? null).toBeNull();
    });
  });

  describe('pipeline validation', () => {
    const createWithReasoning = (reasoning: unknown) => {
      return authenticatedTestClient(adminToken).post('/api/v1/agents').send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'InvalidReasoningAgent',
        reasoning,
      });
    };

    test('rejects an unknown mode', async () => {
      const res = await createWithReasoning({ mode: 'reflect' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects a pipeline with no steps', async () => {
      const res = await createWithReasoning({ mode: 'pipeline', steps: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects more than the maximum number of steps', async () => {
      const steps = Array.from({ length: 9 }, (_unused, i) => {
        return { name: `s${i}`, prompt: 'p' };
      });
      const res = await createWithReasoning({ mode: 'pipeline', steps });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects duplicate step names', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          { name: 'dup', prompt: 'a' },
          { name: 'dup', prompt: 'b' },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects a fanout count out of range', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [{ name: 'a', prompt: 'p', kind: 'fanout', count: 9 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
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

      const override = {
        mode: 'pipeline',
        effort: 'high',
        steps: [{ name: 'final', prompt: 'Refine: {draft}', output: true }],
      };

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Hard question.' }],
          reasoning: override,
        });

      expect(res.status).toBe(200);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      const callArgs = mockCreateGeneration.mock.calls[0][0];
      expect(callArgs.reasoning).toEqual(override);
    });

    test('generate route rejects an invalid reasoning override', async () => {
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'ReasoningOverrideRejectAgent',
        });
      const agentId = agentRes.body.id;

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'Hard question.' }],
          reasoning: { mode: 'pipeline', steps: [] },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });
  });
});
