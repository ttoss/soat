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
    test('agent create round-trips a single implicit-branch step', async () => {
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

    test('agent create round-trips a multi-branch step with per-branch overrides', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'BranchesContractAgent',
          reasoning: {
            mode: 'pipeline',
            steps: [
              {
                name: 'angles',
                prompt: 'Argue an angle on {question}',
                branches: [
                  {
                    name: 'Skeptic',
                    prompt: 'Find the flaw.',
                    temperature: 0.2,
                  },
                  { name: 'Advocate', temperature: 0.9 },
                ],
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
      expect(res.body.reasoning.steps[0].branches).toHaveLength(2);
      expect(res.body.reasoning.steps[0].branches[0].name).toBe('Skeptic');
      expect(res.body.reasoning.steps[0].branches[0].temperature).toBe(0.2);
    });

    test('agent create round-trips a debate step (branches + rounds + {transcript})', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'DebateContractAgent',
          reasoning: {
            mode: 'pipeline',
            steps: [
              {
                name: 'debate',
                rounds: 2,
                branches: [
                  { name: 'Optimist', prompt: 'Argue for. {transcript}' },
                  { name: 'Skeptic', prompt: 'Argue against. {transcript}' },
                ],
              },
              {
                name: 'final',
                prompt: 'Synthesize {steps.debate.last}',
                output: true,
              },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.reasoning.steps[0].rounds).toBe(2);
      expect(res.body.reasoning.steps[0].branches).toHaveLength(2);
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

    test('rejects a dotted step name', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [{ name: 'a.b', prompt: 'p' }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test.each(['kind', 'count', 'perspectives'])(
      'rejects the removed %s field',
      async (field) => {
        // Caught by the strict-fields OpenAPI schema check (VALIDATION_FAILED)
        // before it would otherwise reach validateReasoningConfig's own
        // INVALID_REASONING_CONFIG rejection of the same removed fields.
        const res = await createWithReasoning({
          mode: 'pipeline',
          steps: [{ name: 'a', prompt: 'p', [field]: 'x' }],
        });
        expect(res.status).toBe(400);
      }
    );

    test('rejects branches out of range', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [{ name: 'a', prompt: 'p', branches: [] }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects a prompt referencing an unknown step', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          { name: 'a', prompt: 'p' },
          { name: 'final', prompt: 'Use {steps.typo}', output: true },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects a prompt referencing a later step', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          { name: 'first', prompt: 'Use {steps.second}' },
          { name: 'second', prompt: 'q', output: true },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('accepts a prompt referencing an earlier step', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          { name: 'first', prompt: 'p' },
          { name: 'second', prompt: 'Use {steps.first}', output: true },
        ],
      });
      expect(res.status).toBe(201);
    });

    test('rejects a branch entry with a non-string field', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          {
            name: 'angles',
            prompt: 'p',
            branches: [{ name: 'ok' }, { name: 123 }],
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects haltIfEquals on a multi-branch step', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          {
            name: 'angles',
            prompt: 'p',
            branches: [{ name: 'A' }, { name: 'B' }],
            halt_if_equals: 'APPROVED',
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects rounds > 1 with no {transcript} reference', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          {
            name: 'debate',
            rounds: 2,
            branches: [{ name: 'A' }, { name: 'B' }],
            prompt: 'Argue about {question}',
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('rejects {steps.x.last} referencing an independent multi-branch step', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          {
            name: 'samples',
            prompt: 'Sample {question}',
            branches: [{ name: 'A' }, { name: 'B' }],
          },
          {
            name: 'final',
            prompt: 'Use {steps.samples.last}',
            output: true,
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REASONING_CONFIG');
    });

    test('accepts {steps.x.last} referencing a {transcript}-shared multi-branch step', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          {
            name: 'debate',
            rounds: 2,
            branches: [
              { name: 'A', prompt: 'Argue. {transcript}' },
              { name: 'B', prompt: 'Argue. {transcript}' },
            ],
          },
          { name: 'final', prompt: 'Use {steps.debate.last}', output: true },
        ],
      });
      expect(res.status).toBe(201);
    });

    test('rejects a pipeline exceeding the total completion budget', async () => {
      const res = await createWithReasoning({
        mode: 'pipeline',
        steps: [
          {
            name: 'a',
            prompt: 'p {transcript}',
            rounds: 3,
            branches: [
              { name: 'A1' },
              { name: 'A2' },
              { name: 'A3' },
              { name: 'A4' },
              { name: 'A5' },
            ],
          },
          {
            name: 'b',
            prompt: 'q {transcript}',
            rounds: 2,
            branches: [
              { name: 'B1' },
              { name: 'B2' },
              { name: 'B3' },
              { name: 'B4' },
              { name: 'B5' },
            ],
          },
        ],
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
