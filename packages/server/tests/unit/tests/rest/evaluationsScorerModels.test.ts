import { db } from 'src/db';
import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';

import { setupProjectWithUsers, testGrant } from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
  stubCompletion,
} from '../../fixtures/stubChatProvider';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * What a run pins for each model-backed scorer (`scorer_models`): the model a
 * judge or an embedding scorer resolves when the run starts, which grades every
 * item and enters the run's `scorer_fingerprint`.
 */
describe('eval runs — scorer_models', () => {
  let adminToken: string;
  let projectId: string;
  let agentId: string;
  let judgeProviderId: string;
  let routeA: string;
  let routeB: string;
  let judge: StubChatProvider;
  let judgedModels: string[] = [];

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const unique = (base: string): string => {
    return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  };

  const createRoute = async (model: string): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/model-routes')
      .send({
        project_id: projectId,
        name: unique(model),
        targets: [{ ai_provider_id: judgeProviderId, model }],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const setDefaultRoute = async (routeId: string | null): Promise<void> => {
    const res = await asAdmin()
      .patch(`/api/v1/projects/${projectId}`)
      .send({ default_model_route_id: routeId });
    expect(res.status).toBe(200);
  };

  const createEval = async (scorer: Record<string, unknown>) => {
    const dataset = await asAdmin()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: unique('scorer-models-suite') });
    expect(dataset.status).toBe(201);
    const item = await asAdmin()
      .post(`/api/v1/datasets/${dataset.body.id}/items`)
      .send({
        input: [{ role: 'user', content: 'capital of France?' }],
        expected_output: 'Paris',
      });
    expect(item.status).toBe(201);
    const evaluation = await asAdmin()
      .post('/api/v1/evals')
      .send({
        policy_ids: await testGrant({ token: adminToken }),
        project_id: projectId,
        name: unique('scorer-models-eval'),
        agent_id: agentId,
        dataset_id: dataset.body.id,
        scorers: [scorer],
      });
    expect(evaluation.status).toBe(201);
    return evaluation.body.id as string;
  };

  const startRun = async (evalId: string, wait: boolean) => {
    mockCreateGeneration.mockResolvedValueOnce({
      id: unique('gen'),
      traceId: unique('trc'),
      status: 'completed' as const,
      output: { model: 'test-model', content: 'Paris', finishReason: 'stop' },
    });
    const res = await asAdmin()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait });
    expect(res.status).toBe(201);
    return res.body as { id: string; scorer_models: unknown };
  };

  const fingerprintOf = async (evalId: string, runId: string) => {
    const res = await asAdmin().get(
      `/api/v1/evals/${evalId}/runs/${runId}/calibration`
    );
    expect(res.status).toBe(200);
    return res.body.scorer_fingerprint as string;
  };

  const UNPINNED_JUDGE = {
    type: 'llm_judge',
    name: 'judge',
    prompt: 'A: {{output}}. Answer with JSON.',
    pass_threshold: 0.7,
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';
    const setup = await setupProjectWithUsers({
      prefix: 'scorermodels',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    judge = await startStubChatProvider({
      reply: (request) => {
        judgedModels.push(String(request.model));
        return stubCompletion({ content: '{"score": 0.9}' });
      },
    });

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'scorer-models-judge',
      provider: 'ollama',
      default_model: 'judge-default-model',
      base_url: judge.baseUrl,
    });
    expect(provider.status).toBe(201);
    judgeProviderId = provider.body.id;

    const agent = await asAdmin().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: judgeProviderId,
      name: 'scorer-models-agent',
    });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    routeA = await createRoute('route-a-model');
    routeB = await createRoute('route-b-model');
  });

  afterAll(async () => {
    delete process.env.EVAL_WORKER_DISABLED;
    await judge.close();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    judgedModels = [];
    await db.EvalRunTask.destroy({ where: {}, truncate: true });
  });

  test("a judge pinning no provider pins the project's default route", async () => {
    await setDefaultRoute(routeA);
    const evalId = await createEval(UNPINNED_JUDGE);

    const run = await startRun(evalId, true);

    expect(run.scorer_models).toEqual({
      judge: { model_route_id: routeA },
    });
    expect(judgedModels).toEqual(['route-a-model']);
  });

  test("a judge pinning a provider and no model pins the provider's default model", async () => {
    const evalId = await createEval({
      ...UNPINNED_JUDGE,
      ai_provider_id: judgeProviderId,
    });

    const run = await startRun(evalId, true);

    expect(run.scorer_models).toEqual({
      judge: { ai_provider_id: judgeProviderId, model: 'judge-default-model' },
    });
  });

  test('a change of the default route moves the fingerprint', async () => {
    await setDefaultRoute(routeA);
    const evalId = await createEval(UNPINNED_JUDGE);
    const before = await startRun(evalId, true);
    const again = await startRun(evalId, true);
    await setDefaultRoute(routeB);
    const after = await startRun(evalId, true);

    const fingerprint = await fingerprintOf(evalId, before.id);
    expect(await fingerprintOf(evalId, again.id)).toBe(fingerprint);
    expect(await fingerprintOf(evalId, after.id)).not.toBe(fingerprint);
  });

  test('a run created before a route change grades with its pin', async () => {
    await setDefaultRoute(routeA);
    const evalId = await createEval(UNPINNED_JUDGE);
    const run = await startRun(evalId, false);

    await setDefaultRoute(routeB);
    await drainEvalQueueOnce();

    expect(judgedModels).toEqual(['route-a-model']);
    const read = await asAdmin().get(`/api/v1/evals/${evalId}/runs/${run.id}`);
    expect(read.body.status).toBe('completed');
    expect(read.body.completed_count).toBe(1);
  });

  test('an embedding scorer pins the embedding model and grades with it', async () => {
    const configured = process.env.EMBEDDING_MODEL as string;
    const evalId = await createEval({
      type: 'embedding_similarity',
      name: 'similarity',
      pass_threshold: 0.5,
    });
    const run = await startRun(evalId, false);
    expect(run.scorer_models).toEqual({
      similarity: {
        embedding_provider: process.env.EMBEDDING_PROVIDER,
        model: configured,
      },
    });

    process.env.EMBEDDING_MODEL = 'another-embedding-model';
    try {
      await drainEvalQueueOnce();
    } finally {
      process.env.EMBEDDING_MODEL = configured;
    }

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const events = await db.UsageEvent.findAll({
      where: { source: 'embedding', projectId: project?.id as number },
    });
    expect(
      events.map((event) => {
        return event.model;
      })
    ).toEqual([configured]);
  });
});
