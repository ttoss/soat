import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * What a run is evidence of (the evaluations module doc — Version pinning):
 * the agent its items executed against and the definition that graded them are
 * fixed when the run is created, so editing the Eval afterwards, mid-run or
 * long after, neither regrades the run nor changes what it says it measured.
 */

type Message = { role: string; content: string };

describe('Evaluations — the run records its agent and definition', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let providerId: string;
  let datasetId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createAgent = async (): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerId,
        name: unique('definition-agent'),
        instructions: 'Answer briefly.',
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createEval = async (args: {
    agentId: string;
    body?: Record<string, unknown>;
  }): Promise<string> => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: unique('definition-eval'),
        agent_id: args.agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'ok' }],
        pass_threshold: 0.5,
        ...args.body,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const startQueuedRun = async (evalId: string): Promise<string> => {
    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: false });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
    return res.body.id as string;
  };

  const readRun = async (evalId: string, runId: string) => {
    const res = await asUser().get(`/api/v1/evals/${evalId}/runs/${runId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';

    // The LLM boundary: every item answers `ok`, so a `contains: ok` scorer
    // passes it and a `contains: changed` scorer fails it.
    mockCreateGeneration.mockImplementation(async (args) => {
      const content = (args.messages as Message[])[0]!.content;
      return {
        id: `gen_${content}`,
        traceId: `trc_${content}`,
        status: 'completed' as const,
        output: { model: 'test-model', content: 'ok', finishReason: 'stop' },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'evaldefinition',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:GetDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:ListEvals',
        'evaluations:RunEval',
        'agents:CreateAgentGeneration',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Definition Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(provider.status).toBe(201);
    providerId = provider.body.id;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'definition-dataset' });
    expect(dataset.status).toBe(201);
    datasetId = dataset.body.id;

    for (const [index, kind] of ['a', 'a', 'b', 'b'].entries()) {
      const item = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({
          input: [{ role: 'user', content: `item-${index}` }],
          metadata: { kind },
        });
      expect(item.status).toBe(201);
    }
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
  });

  test('a run reads back the agent and the definition it was created with', async () => {
    const agentId = await createAgent();
    const evalId = await createEval({
      agentId,
      body: { group_by: 'kind', evidence: { required_groups: ['a'] } },
    });

    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });

    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBe(agentId);
    expect(res.body.definition).toEqual({
      scorers: [{ type: 'contains', value: 'ok' }],
      pass_threshold: 0.5,
      group_by: 'kind',
      evidence: { required_groups: ['a'] },
    });

    const listed = await asUser().get(`/api/v1/evals/${evalId}/runs`);
    expect(listed.status).toBe(200);
    expect(listed.body.data[0].agent_id).toBe(agentId);
    expect(listed.body.data[0].definition).toEqual(res.body.definition);
  });

  test('an eval with no threshold records a null threshold, not a null definition', async () => {
    const agentId = await createAgent();
    const evalId = await createEval({
      agentId,
      body: { pass_threshold: null },
    });

    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });

    expect(res.status).toBe(201);
    expect(res.body.definition).not.toBeNull();
    expect(res.body.definition.pass_threshold).toBeNull();
  });

  test('replacing the scorers mid-run does not regrade the queued items', async () => {
    const agentId = await createAgent();
    const evalId = await createEval({ agentId });
    const runId = await startQueuedRun(evalId);

    const edit = await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ scorers: [{ type: 'contains', value: 'changed' }] });
    expect(edit.status).toBe(200);

    expect(await drainEvalQueueOnce()).toBe(4);

    const results = await asUser().get(
      `/api/v1/evals/${evalId}/runs/${runId}/results`
    );
    expect(results.status).toBe(200);
    expect(results.body.data).toHaveLength(4);
    for (const result of results.body.data) {
      expect(result.passed).toBe(true);
    }
  });

  test('lowering the threshold before the run settles leaves its verdict on the recorded one', async () => {
    const agentId = await createAgent();
    // 4 of 4 items pass: the interval's low bound is about 0.51, under 0.9.
    const evalId = await createEval({ agentId, body: { pass_threshold: 0.9 } });
    const runId = await startQueuedRun(evalId);

    const edit = await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ pass_threshold: 0.5 });
    expect(edit.status).toBe(200);

    expect(await drainEvalQueueOnce()).toBe(4);

    const run = await readRun(evalId, runId);
    expect(run.status).toBe('completed');
    expect(run.definition.pass_threshold).toBe(0.9);
    expect(run.verdict).toBe('insufficient');
  });

  test('changing group_by before the run settles keeps the recorded grouping', async () => {
    const agentId = await createAgent();
    const evalId = await createEval({ agentId, body: { group_by: 'kind' } });
    const runId = await startQueuedRun(evalId);

    const edit = await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ group_by: null });
    expect(edit.status).toBe(200);

    expect(await drainEvalQueueOnce()).toBe(4);

    const run = await readRun(evalId, runId);
    expect(run.aggregate_scores.grouping.group_by).toBe('kind');
  });

  test('pointing the eval at another agent mid-run leaves the queued items on the first', async () => {
    const firstAgentId = await createAgent();
    const secondAgentId = await createAgent();
    const evalId = await createEval({ agentId: firstAgentId });
    const runId = await startQueuedRun(evalId);

    const edit = await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ agent_id: secondAgentId });
    expect(edit.status).toBe(200);

    mockCreateGeneration.mockClear();
    expect(await drainEvalQueueOnce()).toBe(4);

    expect(mockCreateGeneration).toHaveBeenCalledTimes(4);
    for (const call of mockCreateGeneration.mock.calls) {
      expect((call[0] as { agentId: string }).agentId).toBe(firstAgentId);
    }
    expect((await readRun(evalId, runId)).agent_id).toBe(firstAgentId);
  });

  test('a run keeps naming its agent after that agent is deleted', async () => {
    const firstAgentId = await createAgent();
    const secondAgentId = await createAgent();
    const evalId = await createEval({ agentId: firstAgentId });

    const run = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });
    expect(run.status).toBe(201);

    // Repointed first, so deleting the agent the run measured does not
    // cascade the eval away with it.
    await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ agent_id: secondAgentId });
    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/agents/${firstAgentId}`
    );
    expect(deleted.status).toBe(204);

    expect((await readRun(evalId, run.body.id)).agent_id).toBe(firstAgentId);
  });

  test('a queued run whose agent is deleted mid-run fails rather than run another agent', async () => {
    const firstAgentId = await createAgent();
    const secondAgentId = await createAgent();
    const evalId = await createEval({ agentId: firstAgentId });
    const runId = await startQueuedRun(evalId);

    // Repointed first, so deleting the recorded agent leaves the eval and the
    // queued run in place.
    await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ agent_id: secondAgentId });
    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/agents/${firstAgentId}`
    );
    expect(deleted.status).toBe(204);

    mockCreateGeneration.mockClear();
    await drainEvalQueueOnce();

    expect(mockCreateGeneration).not.toHaveBeenCalled();
    const run = await readRun(evalId, runId);
    expect(run.status).toBe('failed');
    expect(run.agent_id).toBe(firstAgentId);
  });

  test('the caller cannot write the agent or the definition of a run', async () => {
    const agentId = await createAgent();
    const evalId = await createEval({ agentId });

    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true, definition: { scorers: [] } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
