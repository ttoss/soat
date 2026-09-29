import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * `group_by` (the evaluations module doc — Grouped aggregates): an eval names
 * a key of its items' `metadata`, and a run rolls its scores up per value of
 * that key beside the run-level figures, in `aggregate_scores.grouping` and in
 * the baseline comparison.
 */

type Message = { role: string; content: string };

describe('Evaluations — group_by', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let agentId: string;
  let datasetId: string;
  let protoDatasetId: string;
  let seq = 0;

  // Each item's input names the answer the stubbed agent gives it, so the
  // verdicts are fixed by the fixture rather than by execution order.
  const failing = new Set<string>(['FAIL-refusal', 'FAIL-numeric']);

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const postEval = (body: Record<string, unknown>, token = userToken) => {
    return authenticatedTestClient(token)
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: unique('grouped-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'ok' }],
        ...body,
      });
  };

  const createEval = async (body: Record<string, unknown>) => {
    const res = await postEval(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const runEval = async (
    evalId: string,
    body: Record<string, unknown> = {}
  ) => {
    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true, ...body });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    return res.body as {
      id: string;
      aggregate_scores: Record<string, unknown>;
    };
  };

  const addItem = async (args: {
    dataset: string;
    content: string;
    metadata?: Record<string, unknown>;
  }) => {
    const res = await asUser()
      .post(`/api/v1/datasets/${args.dataset}/items`)
      .send({
        input: [{ role: 'user', content: args.content }],
        metadata: args.metadata,
      });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';

    // The LLM boundary: the reply is a function of the item, and an item
    // whose input says ERROR fails its generation, so it is errored.
    mockCreateGeneration.mockImplementation(async (args) => {
      const content = (args.messages as Message[])[0]!.content;
      if (content.startsWith('ERROR')) throw new Error('provider exploded');
      return {
        id: `gen_${content}`,
        traceId: `trc_${content}`,
        status: 'completed' as const,
        output: {
          model: 'test-model',
          content: failing.has(content) ? 'nope' : 'ok',
          finishReason: 'stop',
        },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'evalgroupby',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:GetDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:RunEval',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Group By Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'Grouped Agent',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    const datasetRes = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'grouped-cases' });
    datasetId = datasetRes.body.id;
    await addItem({
      dataset: datasetId,
      content: 'PASS-refusal',
      metadata: { kind: 'refusal' },
    });
    await addItem({
      dataset: datasetId,
      content: 'FAIL-refusal',
      metadata: { kind: 'refusal' },
    });
    await addItem({
      dataset: datasetId,
      content: 'ERROR-refusal',
      metadata: { kind: 'refusal' },
    });
    await addItem({
      dataset: datasetId,
      content: 'PASS-multi',
      metadata: { kind: 'multi_step' },
    });
    await addItem({ dataset: datasetId, content: 'PASS-unlabelled' });
    await addItem({
      dataset: datasetId,
      content: 'FAIL-numeric',
      metadata: { kind: 7 },
    });

    const protoRes = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'proto-cases' });
    protoDatasetId = protoRes.body.id;
    await addItem({
      dataset: protoDatasetId,
      content: 'PASS-proto',
      metadata: { kind: '__proto__' },
    });
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
    delete process.env.EVAL_WORKER_DISABLED;
  });

  describe('POST /api/v1/evals', () => {
    test('stores and returns group_by', async () => {
      const res = await postEval({ group_by: 'kind' });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^eval_/);
      expect(res.body.group_by).toBe('kind');
    });

    test('an eval declaring none reports group_by null', async () => {
      const res = await postEval({});

      expect(res.status).toBe(201);
      expect(res.body.group_by).toBeNull();
    });

    test.each([
      ['an empty string', ''],
      ['a number', 5],
      ['an object', { key: 'kind' }],
      ['a key longer than 255 characters', 'k'.repeat(256)],
    ])('rejects group_by given as %s', async (_label, groupBy) => {
      const res = await postEval({ group_by: groupBy });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 401 without credentials', async () => {
      const res = await testClient.post('/api/v1/evals').send({
        project_id: projectId,
        name: unique('grouped-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'ok' }],
        group_by: 'kind',
      });

      expect(res.status).toBe(401);
    });

    test('returns 403 for a caller without evaluations:CreateEval', async () => {
      const res = await postEval({ group_by: 'kind' }, noPermToken);

      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/v1/evals/{eval_id}', () => {
    test('sets group_by on an eval that had none', async () => {
      const evalId = await createEval({});

      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ group_by: 'topic' });

      expect(res.status).toBe(200);
      expect(res.body.group_by).toBe('topic');
    });

    test('null clears group_by', async () => {
      const evalId = await createEval({ group_by: 'kind' });

      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ group_by: null });

      expect(res.status).toBe(200);
      expect(res.body.group_by).toBeNull();
    });

    test('omitting group_by leaves it as it was', async () => {
      const evalId = await createEval({ group_by: 'kind' });

      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ pass_threshold: 0.5 });

      expect(res.status).toBe(200);
      expect(res.body.group_by).toBe('kind');
    });

    test('rejects an empty group_by', async () => {
      const evalId = await createEval({});

      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ group_by: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/evals/{eval_id}/runs', () => {
    test('rolls scores up per value of the grouping key', async () => {
      const evalId = await createEval({ group_by: 'kind' });

      const run = await runEval(evalId);

      expect(run.aggregate_scores.pass_rate).toBe(0.6);
      expect(run.aggregate_scores.grouping).toEqual({
        group_by: 'kind',
        groups: {
          refusal: {
            pass_rate: 0.5,
            pass_rate_interval: {
              low: expect.closeTo(0.094531, 6),
              high: expect.closeTo(0.905469, 6),
              level: 0.95,
            },
            scored_item_count: 2,
            scorers: { contains: { mean: 0.5, pass_rate: 0.5 } },
          },
          multi_step: {
            pass_rate: 1,
            pass_rate_interval: {
              low: expect.closeTo(0.206549, 6),
              high: 1,
              level: 0.95,
            },
            scored_item_count: 1,
            scorers: { contains: { mean: 1, pass_rate: 1 } },
          },
        },
        // One item has no `kind`, one has a number: neither names a group.
        ungrouped_item_count: 2,
      });
    });

    test('a run of an eval without group_by reports no grouping', async () => {
      const evalId = await createEval({});

      const run = await runEval(evalId);

      expect(run.aggregate_scores.pass_rate).toBe(0.6);
      expect(run.aggregate_scores.grouping).toBeUndefined();
    });

    test('compares each group against the baseline over its shared items', async () => {
      const evalId = await createEval({ group_by: 'kind' });
      const baseline = await runEval(evalId);

      failing.delete('FAIL-refusal');
      let run;
      try {
        run = await runEval(evalId, { baseline_run_id: baseline.id });
      } finally {
        failing.add('FAIL-refusal');
      }

      const comparison = run.aggregate_scores.baseline as Record<
        string,
        unknown
      >;
      expect(comparison.pass_rate_delta).toBeCloseTo(0.2);
      expect(comparison.grouping).toEqual({
        group_by: 'kind',
        groups: {
          refusal: {
            compared_item_count: 2,
            added_item_count: 0,
            removed_item_count: 0,
            pass_rate_delta: 0.5,
            flipped: { improved: 1, regressed: 0 },
            p_value: 1,
            scorers: { contains: { mean_delta: 0.5, pass_rate_delta: 0.5 } },
          },
          multi_step: {
            compared_item_count: 1,
            added_item_count: 0,
            removed_item_count: 0,
            pass_rate_delta: 0,
            flipped: { improved: 0, regressed: 0 },
            p_value: 1,
            scorers: { contains: { mean_delta: 0, pass_rate_delta: 0 } },
          },
        },
        ungrouped_item_count: 2,
      });
    });

    test('a group only the current run names reads as added items', async () => {
      const growing = await asUser()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: unique('growing-cases') });
      await addItem({
        dataset: growing.body.id,
        content: 'PASS-early',
        metadata: { kind: 'early' },
      });
      const evalId = await createEval({
        group_by: 'kind',
        dataset_id: growing.body.id,
      });
      const baseline = await runEval(evalId);
      await addItem({
        dataset: growing.body.id,
        content: 'PASS-late',
        metadata: { kind: 'late' },
      });

      const run = await runEval(evalId, { baseline_run_id: baseline.id });

      const comparison = run.aggregate_scores.baseline as {
        grouping: { groups: Record<string, unknown> };
      };
      expect(comparison.grouping.groups).toEqual({
        early: {
          compared_item_count: 1,
          added_item_count: 0,
          removed_item_count: 0,
          pass_rate_delta: 0,
          flipped: { improved: 0, regressed: 0 },
          p_value: 1,
          scorers: { contains: { mean_delta: 0, pass_rate_delta: 0 } },
        },
        late: {
          compared_item_count: 0,
          added_item_count: 1,
          removed_item_count: 0,
          pass_rate_delta: null,
          flipped: { improved: 0, regressed: 0 },
          p_value: null,
          scorers: {},
        },
      });
    });

    test('a baseline result whose item was deleted names no group', async () => {
      const shrinking = await asUser()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: unique('shrinking-cases') });
      await addItem({
        dataset: shrinking.body.id,
        content: 'PASS-kept',
        metadata: { kind: 'kept' },
      });
      const doomed = await asUser()
        .post(`/api/v1/datasets/${shrinking.body.id}/items`)
        .send({
          input: [{ role: 'user', content: 'PASS-doomed' }],
          metadata: { kind: 'kept' },
        });
      const evalId = await createEval({
        group_by: 'kind',
        dataset_id: shrinking.body.id,
      });
      const baseline = await runEval(evalId);
      const deleted = await asUser().delete(
        `/api/v1/datasets/${shrinking.body.id}/items/${doomed.body.id}`
      );
      expect(deleted.status).toBe(204);

      const run = await runEval(evalId, { baseline_run_id: baseline.id });

      const comparison = run.aggregate_scores.baseline as {
        grouping: Record<string, unknown>;
      };
      expect(comparison.grouping).toEqual({
        group_by: 'kind',
        groups: {
          kept: {
            compared_item_count: 1,
            added_item_count: 0,
            removed_item_count: 0,
            pass_rate_delta: 0,
            flipped: { improved: 0, regressed: 0 },
            p_value: 1,
            scorers: { contains: { mean_delta: 0, pass_rate_delta: 0 } },
          },
        },
        ungrouped_item_count: 0,
      });
    });

    test('a group value spelled __proto__ is an ordinary group', async () => {
      const evalId = await createEval({
        group_by: 'kind',
        dataset_id: protoDatasetId,
      });

      const run = await runEval(evalId);

      const grouping = run.aggregate_scores.grouping as {
        groups: Record<string, { pass_rate: number }>;
      };
      expect(Object.keys(grouping.groups)).toEqual(['__proto__']);
      expect(
        Object.getOwnPropertyDescriptor(grouping.groups, '__proto__')?.value
          .pass_rate
      ).toBe(1);
    });
  });
});
