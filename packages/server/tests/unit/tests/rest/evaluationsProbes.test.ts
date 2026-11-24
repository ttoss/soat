import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
  stubCompletion,
} from '../../fixtures/stubChatProvider';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Probes (the evaluations module doc — Criteria): each criterion's fixed
 * outputs, graded by its scorers before a run's first item and on the dry-run
 * route. A probe holds when the criterion's verdict on it (every scorer
 * passed) is the one it declares.
 */

type GenerationCall = { messages: Array<{ content: string }> };

const SCORERS = [
  { type: 'contains', name: 'mentions_refund', value: 'refund' },
  { type: 'contains', name: 'mentions_cancel', value: 'cancel' },
];

const criteria = (cancelProbe: { output: string; passed: boolean }) => {
  return [
    {
      name: 'explains_refund',
      description: 'Names the refund',
      scorers: ['mentions_refund'],
      probes: [
        { output: 'Your refund is on its way.', passed: true },
        { output: 'Hello.', passed: false },
      ],
    },
    {
      name: 'offers_cancellation',
      description: 'Offers to cancel the order',
      scorers: ['mentions_cancel'],
      probes: [cancelProbe, { output: 'Hello.', passed: false }],
    },
  ];
};

const HOLDING = criteria({ output: 'I can cancel it.', passed: true });
// `mentions_cancel` fails "I can stop it.", so the probe that says it passes
// does not hold.
const BROKEN = criteria({ output: 'I can stop it.', passed: true });

describe('Evaluations — probes', () => {
  let adminToken: string;
  let userToken: string;
  let userPolicyId: string;
  let projectId: string;
  let agentId: string;
  let datasetId: string;
  let otherProjectProviderId: string;
  let judgeProviderId: string;
  let judge: StubChatProvider;
  /** Runs inside the judge's reply, before it answers. */
  let whileJudging: () => Promise<void> = () => {
    return Promise.resolve();
  };
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createEval = async (extra: Record<string, unknown>) => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('probe-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: SCORERS,
        pass_threshold: 0.3,
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const drain = async () => {
    while ((await drainEvalQueueOnce()) > 0) {
      // A probe gate releases the run's other items for the next claim.
    }
  };

  const runOf = async (evalId: string, runId: string) => {
    const res = await asUser().get(`/api/v1/evals/${evalId}/runs/${runId}`);
    expect(res.status).toBe(200);
    return res.body as { status: string };
  };

  const runCount = async (evalId: string) => {
    const res = await asUser().get(`/api/v1/evals/${evalId}/runs`);
    expect(res.status).toBe(200);
    return (res.body.data as Array<{ id: string }>).length;
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';
    mockCreateGeneration.mockImplementation(async (args) => {
      const content = (args as GenerationCall).messages[0]!.content;
      return {
        id: `gen_${content}_${unique('g')}`,
        traceId: `trc_${content}_${unique('t')}`,
        status: 'completed' as const,
        output: {
          model: 'test-model',
          content: 'Your refund is on its way; I can cancel it.',
          finishReason: 'stop' as const,
        },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'evalprobes',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:ListEvals',
        'evaluations:RunEval',
        'evaluations:CancelEvalRun',
        'agents:CreateAgentGeneration',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userPolicyId = setup.policyId as string;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Probes Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Probes Agent',
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id as string;

    // Scores 0.9 a reply that offers help and 0.1 anything else.
    judge = await startStubChatProvider({
      reply: async (request) => {
        await whileJudging();
        const helpful = JSON.stringify(request).includes('Glad to help');
        return stubCompletion({
          content: `{"score": ${helpful ? 0.9 : 0.1}, "reasoning": "r"}`,
        });
      },
    });
    const judgeProvider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Probes Judge',
        provider: 'ollama',
        default_model: 'judge-model',
        base_url: judge.baseUrl,
      });
    expect(judgeProvider.status).toBe(201);
    judgeProviderId = judgeProvider.body.id as string;

    const otherProject = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: unique('Probes Other Project') });
    const otherProvider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProject.body.id,
        name: 'Other Probes Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(otherProvider.status).toBe(201);
    otherProjectProviderId = otherProvider.body.id as string;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'probe-cases' });
    datasetId = dataset.body.id as string;
    // Two items, so a queued run holds the second behind its probes.
    for (const content of ['one', 'two']) {
      const item = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content }] });
      expect(item.status).toBe(201);
    }
  });

  beforeEach(() => {
    mockCreateGeneration.mockClear();
  });

  afterEach(() => {
    whileJudging = () => {
      return Promise.resolve();
    };
  });

  afterAll(async () => {
    await judge.close();
    mockCreateGeneration.mockReset();
    delete process.env.EVAL_WORKER_DISABLED;
  });

  describe('POST /api/v1/evals/{eval_id}/probes', () => {
    test('reports every probe holding, and creates no run', async () => {
      const evalId = await createEval({ criteria: HOLDING });

      const res = await asUser().post(`/api/v1/evals/${evalId}/probes`);

      expect(res.status).toBe(200);
      expect(res.body.passed).toBe(true);
      expect(res.body.probes).toHaveLength(4);
      expect(res.body.probes[0]).toEqual({
        criterion: 'explains_refund',
        index: 0,
        expected: true,
        passed: true,
        held: true,
        scores: [
          expect.objectContaining({ scorer: 'mentions_refund', passed: true }),
        ],
      });
      expect(await runCount(evalId)).toBe(0);
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('names the probe that does not hold', async () => {
      const evalId = await createEval({ criteria: BROKEN });

      const res = await asUser().post(`/api/v1/evals/${evalId}/probes`);

      expect(res.status).toBe(200);
      expect(res.body.passed).toBe(false);
      expect(
        (res.body.probes as Array<{ held: boolean }>).filter((probe) => {
          return !probe.held;
        })
      ).toEqual([
        expect.objectContaining({
          criterion: 'offers_cancellation',
          index: 0,
          expected: true,
          passed: false,
          held: false,
        }),
      ]);
    });

    test('grades the structured object and the metadata of a probe', async () => {
      const evalId = await createEval({
        scorers: [
          {
            type: 'json_logic',
            name: 'approved',
            expression: {
              and: [
                { '==': [{ var: 'object.approved' }, true] },
                { '==': [{ var: 'item.metadata.kind' }, 'refund'] },
              ],
            },
          },
        ],
        criteria: [
          {
            name: 'approves_refunds',
            description: 'Approves a refund request',
            scorers: ['approved'],
            probes: [
              {
                output: 'Approved.',
                object: { approved: true },
                metadata: { kind: 'refund' },
                passed: true,
              },
              {
                output: 'Declined.',
                object: { approved: false },
                metadata: { kind: 'refund' },
                passed: false,
              },
            ],
          },
        ],
      });

      const res = await asUser().post(`/api/v1/evals/${evalId}/probes`);

      expect(res.status).toBe(200);
      expect(res.body.passed).toBe(true);
    });

    test('an eval without criteria has no probes to run', async () => {
      const evalId = await createEval({});
      const res = await asUser().post(`/api/v1/evals/${evalId}/probes`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ passed: true, probes: [] });
    });

    test('returns 403 without evaluations:RunEval', async () => {
      const evalId = await createEval({ criteria: HOLDING });
      const reader = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('probe-reader'),
        actions: ['evaluations:GetEval', 'evaluations:ListEvals'],
      });
      const res = await authenticatedTestClient(reader).post(
        `/api/v1/evals/${evalId}/probes`
      );
      expect(res.status).toBe(403);
    });

    test('returns 404 for an unknown eval', async () => {
      const res = await asUser().post(
        '/api/v1/evals/eval_doesnotexist000/probes'
      );
      expect(res.status).toBe(404);
    });

    test('returns 401 without a credential', async () => {
      const evalId = await createEval({ criteria: HOLDING });
      const res = await testClient.post(`/api/v1/evals/${evalId}/probes`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/evals/{eval_id}/runs', () => {
    test('a probe that does not hold fails a synchronous run before its first item', async () => {
      const evalId = await createEval({ criteria: BROKEN });

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PROBE_FAILED');
      expect(res.body.error.meta).toMatchObject({
        failed: [
          expect.objectContaining({
            criterion: 'offers_cancellation',
            index: 0,
          }),
        ],
      });
      const runId = res.body.error.meta.eval_run_id as string;
      expect((await runOf(evalId, runId)).status).toBe('failed');
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('a queued run answers at once, and a probe that does not hold fails it in the worker', async () => {
      const evalId = await createEval({ criteria: BROKEN });

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('queued');

      await drain();

      expect((await runOf(evalId, res.body.id)).status).toBe('failed');
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('a queued run whose probes hold runs every item', async () => {
      const evalId = await createEval({ criteria: HOLDING });

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      expect(res.status).toBe(201);

      await drain();

      expect((await runOf(evalId, res.body.id)).status).toBe('completed');
      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);
    });

    test('a queued run cancelled while its probes are graded runs no item', async () => {
      const evalId = await createEval({
        scorers: [
          ...SCORERS,
          {
            type: 'llm_judge',
            name: 'judge',
            ai_provider_id: judgeProviderId,
            prompt: 'Rate {{output}}',
            pass_threshold: 0.5,
          },
        ],
        criteria: [
          ...HOLDING,
          {
            name: 'judged',
            description: 'Reads as helpful',
            scorers: ['judge'],
            probes: [
              { output: 'Glad to help.', passed: true },
              { output: 'No.', passed: false },
            ],
          },
        ],
      });
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      expect(res.status).toBe(201);
      const runId = res.body.id as string;
      whileJudging = async () => {
        whileJudging = () => {
          return Promise.resolve();
        };
        const cancel = await asUser().post(
          `/api/v1/evals/${evalId}/runs/${runId}/cancel`
        );
        expect(cancel.status).toBe(200);
      };

      await drain();

      const run = await runOf(evalId, runId);
      expect(run.status).toBe('cancelled');
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('a scorer that cannot grade a probe fails the run with its own error, not PROBE_FAILED', async () => {
      const evalId = await createEval({
        scorers: [
          ...SCORERS,
          {
            type: 'llm_judge',
            name: 'judge',
            ai_provider_id: otherProjectProviderId,
            prompt: 'Rate {{output}}',
            pass_threshold: 0.5,
          },
        ],
        criteria: [
          ...HOLDING,
          {
            name: 'judged',
            description: 'Reads as helpful',
            scorers: ['judge'],
            probes: [
              { output: 'Glad to help.', passed: true },
              { output: 'No.', passed: false },
            ],
          },
        ],
      });

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('holding probes let a synchronous run go on', async () => {
      const evalId = await createEval({ criteria: HOLDING });
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');
    });
  });
});
