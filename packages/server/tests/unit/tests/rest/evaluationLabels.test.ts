import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A person's verdict on a result (the evaluations module doc — Calibrating a
 * judge): `PUT …/results/{id}/label` records it beside the scorers' outcomes,
 * `DELETE` clears it, and the result's own `passed` never moves.
 */

type GenerationCall = { messages: Array<{ content: string }> };

describe('Evaluations — human labels on results', () => {
  let adminToken: string;
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

  /** A completed run of 2 items, every one passing `contains: refund`. */
  const completedRun = async () => {
    const evalRes = await asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('label-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'refund' }],
        pass_threshold: 0.5,
      });
    expect(evalRes.status).toBe(201);
    const evalId = evalRes.body.id as string;
    const runRes = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });
    expect(runRes.status).toBe(201);
    const runId = runRes.body.id as string;
    const results = await asUser().get(
      `/api/v1/evals/${evalId}/runs/${runId}/results`
    );
    expect(results.status).toBe(200);
    const [first] = results.body.data as Array<{ id: string }>;
    return {
      evalId,
      runId,
      resultId: first!.id,
      labelPath: `/api/v1/evals/${evalId}/runs/${runId}/results/${first!.id}/label`,
      resultsPath: `/api/v1/evals/${evalId}/runs/${runId}/results`,
    };
  };

  const resultOf = async (resultsPath: string, resultId: string) => {
    const res = await asUser().get(resultsPath);
    expect(res.status).toBe(200);
    return (res.body.data as Array<Record<string, unknown>>).find((result) => {
      return result.id === resultId;
    });
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
      prefix: 'evallabels',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:ListEvals',
        'evaluations:RunEval',
        'evaluations:LabelEvalResult',
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
        name: 'Labels Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Labels Agent',
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id as string;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'label-cases' });
    datasetId = dataset.body.id as string;
    for (const content of ['one', 'two']) {
      const item = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content }] });
      expect(item.status).toBe(201);
    }
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
    delete process.env.EVAL_WORKER_DISABLED;
  });

  describe('PUT /api/v1/evals/{eval_id}/runs/{eval_run_id}/results/{eval_result_id}/label', () => {
    test('records the label beside the outcome, leaving passed as scored', async () => {
      const run = await completedRun();

      const res = await asUser()
        .put(run.labelPath)
        .send({ passed: false, note: 'Promised a refund it cannot give.' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: run.resultId,
        passed: true,
        human_label: {
          passed: false,
          note: 'Promised a refund it cannot give.',
          labeled_by_principal_type: 'user',
          labeled_by_principal_id: expect.any(String),
          labeled_at: expect.any(String),
        },
      });
      expect(await resultOf(run.resultsPath, run.resultId)).toMatchObject({
        human_label: { passed: false },
      });
    });

    test('a result nobody labeled has no label', async () => {
      const run = await completedRun();
      expect(await resultOf(run.resultsPath, run.resultId)).toMatchObject({
        human_label: null,
      });
    });

    test('a second label replaces the first, and a label needs no note', async () => {
      const run = await completedRun();
      await asUser().put(run.labelPath).send({ passed: false, note: 'No.' });

      const res = await asUser().put(run.labelPath).send({ passed: true });

      expect(res.status).toBe(200);
      expect(res.body.human_label).toMatchObject({ passed: true, note: null });
    });

    test.each([
      ['a non-boolean passed', { passed: 'yes' }],
      ['no passed', { note: 'Fine.' }],
      ['an unknown field', { passed: true, score: 1 }],
    ])('refuses %s with 400', async (_label, body) => {
      const run = await completedRun();
      const res = await asUser().put(run.labelPath).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 404 for a result of another run', async () => {
      const run = await completedRun();
      const other = await completedRun();
      const res = await asUser()
        .put(
          `/api/v1/evals/${run.evalId}/runs/${run.runId}/results/${other.resultId}/label`
        )
        .send({ passed: true });
      expect(res.status).toBe(404);
    });

    test('returns 401 without a credential', async () => {
      const run = await completedRun();
      const res = await testClient.put(run.labelPath).send({ passed: true });
      expect(res.status).toBe(401);
    });

    test('only LabelEvalResult labels', async () => {
      const run = await completedRun();
      const reader = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('label-reader'),
        actions: ['evaluations:GetEval', 'evaluations:ListEvals'],
      });
      const labeler = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('labeler'),
        actions: ['evaluations:LabelEvalResult'],
      });

      const refused = await authenticatedTestClient(reader)
        .put(run.labelPath)
        .send({ passed: true });
      expect(refused.status).toBe(403);
      const allowed = await authenticatedTestClient(labeler)
        .put(run.labelPath)
        .send({ passed: true });
      expect(allowed.status).toBe(200);
    });
  });

  describe('DELETE /api/v1/evals/{eval_id}/runs/{eval_run_id}/results/{eval_result_id}/label', () => {
    test('clears the label', async () => {
      const run = await completedRun();
      await asUser().put(run.labelPath).send({ passed: false });

      const res = await asUser().delete(run.labelPath);

      expect(res.status).toBe(204);
      expect(await resultOf(run.resultsPath, run.resultId)).toMatchObject({
        human_label: null,
      });
    });

    test('returns 403 without LabelEvalResult', async () => {
      const run = await completedRun();
      const reader = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('unlabel-reader'),
        actions: ['evaluations:GetEval', 'evaluations:ListEvals'],
      });
      const res = await authenticatedTestClient(reader).delete(run.labelPath);
      expect(res.status).toBe(403);
    });
  });
});
