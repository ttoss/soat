import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Every scorer has a `name`, and the name is the key its outcomes go under
 * (the evaluations module doc — Scorers): `scores[].scorer`,
 * `aggregate_scores.scorers` and the calibration report.
 */

type GenerationCall = { messages: Array<{ content: string }> };

describe('Evaluations — scorer names', () => {
  let userToken: string;
  let userPolicyId: string;
  let projectId: string;
  let agentId: string;
  let datasetId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createEval = (scorers: unknown[]) => {
    return asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('named-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers,
        pass_threshold: 0.5,
      });
  };

  const run = async (evalId: string) => {
    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });
    expect(res.status).toBe(201);
    const results = await asUser().get(
      `/api/v1/evals/${evalId}/runs/${res.body.id}/results`
    );
    expect(results.status).toBe(200);
    return {
      run: res.body as { aggregate_scores: { scorers: object } },
      results: results.body.data as Array<{
        scores: Array<{ scorer: string; passed: boolean }>;
      }>,
    };
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
          content: 'refund policy',
          finishReason: 'stop' as const,
        },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'scorernames',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:ListEvals',
        'evaluations:RunEval',
        'agents:CreateAgentGeneration',
      ],
    });
    userToken = setup.userToken;
    userPolicyId = setup.policyId as string;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Names Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Names Agent',
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id as string;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'name-cases' });
    datasetId = dataset.body.id as string;
    const item = await asUser()
      .post(`/api/v1/datasets/${datasetId}/items`)
      .send({ input: [{ role: 'user', content: 'one' }] });
    expect(item.status).toBe(201);
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
    delete process.env.EVAL_WORKER_DISABLED;
  });

  describe('POST /api/v1/evals', () => {
    test('refuses a scorer without a name', async () => {
      const res = await createEval([{ type: 'contains', value: 'refund' }]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/scorers\.0\.name/);
    });

    test('refuses two scorers sharing a name, whatever their types', async () => {
      const res = await createEval([
        { type: 'contains', name: 'mentions', value: 'refund' },
        { type: 'exact_match', name: 'mentions' },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/scorers\.1\.name 'mentions'/);
    });

    test('takes two scorers of one type under different names, and keys each outcome by its name', async () => {
      const created = await createEval([
        { type: 'contains', name: 'mentions_refund', value: 'refund' },
        { type: 'contains', name: 'mentions_policy', value: 'policy' },
      ]);
      expect(created.status).toBe(201);

      const { run: settled, results } = await run(created.body.id);

      expect(
        results[0]!.scores.map((outcome) => {
          return outcome.scorer;
        })
      ).toEqual(['mentions_refund', 'mentions_policy']);
      expect(Object.keys(settled.aggregate_scores.scorers).sort()).toEqual([
        'mentions_policy',
        'mentions_refund',
      ]);
    });

    test('takes a name equal to a scorer type', async () => {
      const res = await createEval([
        { type: 'contains', name: 'contains', value: 'refund' },
      ]);
      expect(res.status).toBe(201);
    });
  });

  describe('PUT /api/v1/evals/{eval_id}', () => {
    test('refuses scorers without a name', async () => {
      const created = await createEval([
        { type: 'contains', name: 'mentions', value: 'refund' },
      ]);
      const res = await asUser()
        .put(`/api/v1/evals/${created.body.id}`)
        .send({ scorers: [{ type: 'exact_match' }] });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/scorers\.0\.name/);
    });

    test('returns 401 without a credential', async () => {
      const created = await createEval([
        { type: 'contains', name: 'mentions', value: 'refund' },
      ]);
      const res = await testClient
        .put(`/api/v1/evals/${created.body.id}`)
        .send({ scorers: [{ type: 'exact_match', name: 'exact' }] });
      expect(res.status).toBe(401);
    });
  });

  test('a stored scorer without a name is refused at run start', async () => {
    const created = await createEval([
      { type: 'contains', name: 'mentions', value: 'refund' },
    ]);
    await db.Eval.update(
      { scorers: [{ type: 'contains', value: 'refund' }] },
      { where: { publicId: created.body.id } }
    );

    const res = await asUser()
      .post(`/api/v1/evals/${created.body.id}/runs`)
      .send({ wait: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toContain('scorers.0.name is required');
  });
});
