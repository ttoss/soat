import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
  stubCompletion,
} from '../../fixtures/stubChatProvider';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * Which model an `llm_judge` scorer grades with. A judge has no agent to
 * inherit a binding from, so it resolves against the eval's project: its
 * pinned provider must belong to that project, and with no pinned `model` the
 * provider's default applies. The judge runs against a local stub; only the
 * agent's own generation is mocked (`mockCreateGeneration`).
 */
describe('POST /api/v1/evals/:eval_id/runs — llm_judge provider resolution', () => {
  let adminToken: string;
  let projectId: string;
  let agentId: string;
  let judgeProviderId: string;
  let otherProjectProviderId: string;
  let judge: StubChatProvider;
  let judgedModels: string[] = [];

  beforeAll(async () => {
    // Runs are driven with `wait: true`; a background kick would race them for
    // the queued generation mock.
    process.env.EVAL_WORKER_DISABLED = 'true';

    const setup = await setupProjectWithUsers({
      prefix: 'judgeprovider',
      policyActions: [],
      createNoPermUser: false,
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    judge = await startStubChatProvider({
      reply: (request) => {
        judgedModels.push(String(request.model));
        return stubCompletion({
          content: '{"score": 0.9, "reasoning": "close enough"}',
        });
      },
    });

    const createProvider = async (args: {
      project: string;
      name: string;
      baseUrl?: string;
    }) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: args.project,
          name: args.name,
          provider: 'ollama',
          default_model: 'judge-default-model',
          ...(args.baseUrl ? { base_url: args.baseUrl } : {}),
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    judgeProviderId = await createProvider({
      project: projectId,
      name: 'judge-provider',
      baseUrl: judge.baseUrl,
    });
    otherProjectProviderId = await createProvider({
      project: setup.otherProjectId as string,
      name: 'other-project-judge-provider',
      baseUrl: judge.baseUrl,
    });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: judgeProviderId,
        name: 'judged-agent',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;
  });

  afterAll(async () => {
    delete process.env.EVAL_WORKER_DISABLED;
    await judge.close();
  });

  afterEach(async () => {
    // Shared spy: clear, never restore.
    jest.clearAllMocks();
    judgedModels = [];
    await db.EvalRunTask.destroy({ where: {}, truncate: true });
  });

  const runJudged = async (scorer: Record<string, unknown>) => {
    const datasetRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: `judge-suite-${Date.now()}` });
    expect(datasetRes.status).toBe(201);
    const itemRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/datasets/${datasetRes.body.id}/items`)
      .send({
        input: [{ role: 'user', content: 'capital of France?' }],
        expected_output: 'Paris',
      });
    expect(itemRes.status).toBe(201);
    const evalRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: `judge-eval-${Date.now()}`,
        agent_id: agentId,
        dataset_id: datasetRes.body.id,
        scorers: [
          {
            type: 'llm_judge',
            prompt: 'A: {{output}}. Answer with JSON.',
            pass_threshold: 0.7,
            ...scorer,
          },
        ],
      });
    expect(evalRes.status).toBe(201);

    mockCreateGeneration.mockResolvedValueOnce({
      id: 'gen_judged',
      traceId: 'trc_gen_judged',
      status: 'completed' as const,
      output: { model: 'test-model', content: 'Paris', finishReason: 'stop' },
    });
    const runRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/evals/${evalRes.body.id}/runs`)
      .send({ wait: true });
    expect(runRes.status).toBe(201);

    const results = await authenticatedTestClient(adminToken).get(
      `/api/v1/evals/${evalRes.body.id}/runs/${runRes.body.id}/results`
    );
    expect(results.status).toBe(200);
    return { run: runRes.body, result: results.body.data[0] };
  };

  test("a judge that pins no model grades with its provider's default", async () => {
    const { result } = await runJudged({ ai_provider_id: judgeProviderId });

    expect(judgedModels).toEqual(['judge-default-model']);
    expect(result.scores).toEqual([
      expect.objectContaining({ scorer: 'llm_judge', score: 0.9 }),
    ]);
  });

  // A scorer config can never borrow another project's provider secret.
  test("a judge naming another project's provider errors the item, not the run", async () => {
    const { run, result } = await runJudged({
      ai_provider_id: otherProjectProviderId,
    });

    expect(run.status).toBe('completed');
    expect(run.errored_count).toBe(1);
    expect(result.error).toMatch(/not found in the project/);
    expect(judgedModels).toEqual([]);
  });
});
