import { db } from 'src/db';
import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { pollUntil } from '../../fixtures/poll';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A run records its agent and `definition` (scorers, `pass_threshold`,
 * `group_by`) when it is created, and every later step reads them from the
 * run: an edit to its Eval reaches only runs created after it.
 */

type GenerationCall = {
  agentId?: string;
  messages: Array<{ content: string }>;
};

describe('Evaluations — a run records its agent and definition', () => {
  let adminToken: string;
  let userToken: string;
  let userPolicyId: string;
  let noPermToken: string;
  let projectId: string;
  let providerId: string;
  let firstAgentId: string;
  let secondAgentId: string;
  let datasetId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const createAgent = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({ project_id: projectId, ai_provider_id: providerId, name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createEval = async (body: Record<string, unknown> = {}) => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('definition-eval'),
        agent_id: firstAgentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', name: 'contains', value: 'refund' }],
        pass_threshold: 0.5,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const updateEval = async (evalId: string, body: Record<string, unknown>) => {
    const res = await asUser().put(`/api/v1/evals/${evalId}`).send(body);
    expect(res.status).toBe(200);
  };

  const startQueuedRun = async (evalId: string) => {
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

  const results = async (evalId: string, runId: string) => {
    const res = await asUser().get(
      `/api/v1/evals/${evalId}/runs/${runId}/results`
    );
    expect(res.status).toBe(200);
    return res.body.data as Array<{ passed: boolean }>;
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';

    // Every item answers "refund policy", so `contains: refund` passes it and
    // any other `contains` value fails it.
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
    userPolicyId = setup.policyId;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Definition Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    providerId = providerRes.body.id;
    firstAgentId = await createAgent('Definition First Agent');
    secondAgentId = await createAgent('Definition Second Agent');

    const datasetRes = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'definition-cases' });
    datasetId = datasetRes.body.id;
    for (const [content, kind] of [
      ['one', 'refusal'],
      ['two', 'multi_step'],
    ]) {
      const item = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({
          input: [{ role: 'user', content }],
          metadata: { kind, tier: 'gold' },
        });
      expect(item.status).toBe(201);
    }
  });

  beforeEach(() => {
    mockCreateGeneration.mockClear();
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
    delete process.env.EVAL_WORKER_DISABLED;
  });

  test('a queued run scores every item by the scorers it started with', async () => {
    const evalId = await createEval();
    const runId = await startQueuedRun(evalId);

    await updateEval(evalId, {
      scorers: [{ type: 'contains', name: 'contains', value: 'never-said' }],
    });
    await drainEvalQueueOnce();

    const rows = await results(evalId, runId);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => {
        return row.passed;
      })
    ).toBe(true);
  });

  test('a queued run settles its verdict on the threshold it started with', async () => {
    const evalId = await createEval({
      scorers: [{ type: 'contains', name: 'contains', value: 'never-said' }],
      pass_threshold: 0.9,
    });
    const runId = await startQueuedRun(evalId);

    await updateEval(evalId, { pass_threshold: 0 });
    await drainEvalQueueOnce();

    const run = await readRun(evalId, runId);
    expect(run.status).toBe('completed');
    expect(run.definition.pass_threshold).toBe(0.9);
    // 0 of 2 under 0.9 refutes; under the edited 0 it would be supported.
    expect(run.verdict).toBe('refuted');
  });

  test('a queued run settles on the evidence it started with', async () => {
    // At threshold 0 the run's own interval is supported; only the required
    // group, which no item belongs to, holds it at insufficient.
    const evalId = await createEval({
      pass_threshold: 0,
      group_by: 'kind',
      evidence: { required_groups: ['absent'] },
    });
    const runId = await startQueuedRun(evalId);

    await updateEval(evalId, { evidence: null });
    await drainEvalQueueOnce();

    const run = await readRun(evalId, runId);
    expect(run.status).toBe('completed');
    expect(run.verdict).toBe('insufficient');
    expect(run.verdict_reasons).toContainEqual(
      expect.objectContaining({
        scope: { kind: 'group', name: 'absent' },
        verdict: 'insufficient',
      })
    );
  });

  test('a queued run executes every item against the agent it started with', async () => {
    const evalId = await createEval();
    const runId = await startQueuedRun(evalId);

    await updateEval(evalId, { agent_id: secondAgentId });
    await drainEvalQueueOnce();

    expect(mockCreateGeneration).toHaveBeenCalledTimes(2);
    for (const [call] of mockCreateGeneration.mock.calls) {
      expect((call as GenerationCall).agentId).toBe(firstAgentId);
    }
    expect((await readRun(evalId, runId)).agent_id).toBe(firstAgentId);
  });

  test('start, get and list return the agent and definition at start', async () => {
    const evalId = await createEval({
      group_by: 'kind',
      evidence: { required_groups: ['refusal'] },
    });
    const expected = {
      error: null,
      agent_id: firstAgentId,
      definition: {
        scorers: [{ type: 'contains', name: 'contains', value: 'refund' }],
        pass_threshold: 0.5,
        group_by: 'kind',
        evidence: { required_groups: ['refusal'] },
      },
    };

    const started = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject(expected);

    await updateEval(evalId, {
      agent_id: secondAgentId,
      scorers: [{ type: 'exact_match', name: 'exact_match' }],
      pass_threshold: 0.1,
      group_by: 'tier',
      evidence: null,
    });

    expect(await readRun(evalId, started.body.id)).toMatchObject(expected);
    const list = await asUser().get(`/api/v1/evals/${evalId}/runs`);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject(expected);
  });

  test('a queued run groups by the key it started with', async () => {
    const evalId = await createEval({ group_by: 'kind' });
    const runId = await startQueuedRun(evalId);

    await updateEval(evalId, { group_by: 'tier' });
    await drainEvalQueueOnce();

    const run = await readRun(evalId, runId);
    expect(run.definition.group_by).toBe('kind');
    expect(run.aggregate_scores.grouping.group_by).toBe('kind');
  });

  test('an eval without a threshold records a definition whose threshold is null', async () => {
    const evalId = await createEval({ pass_threshold: null });

    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });

    expect(res.status).toBe(201);
    expect(res.body.definition).not.toBeNull();
    expect(res.body.definition.pass_threshold).toBeNull();
    expect(res.body.verdict).toBeNull();
  });

  test('the eval_runs.completed payload carries the agent and definition', async () => {
    const evalId = await createEval();
    const captured: SoatEvent[] = [];
    const handler = (event: SoatEvent) => {
      if (event.type === 'eval_runs.completed') captured.push(event);
    };
    eventBus.on('soat:event', handler);
    let runId = '';
    try {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });
      runId = res.body.id as string;
      await pollUntil({
        read: () => {
          return captured;
        },
        done: (events) => {
          return events.some((event) => {
            return event.resourceId === runId;
          });
        },
      });
    } finally {
      eventBus.off('soat:event', handler);
    }

    const event = captured.find((candidate) => {
      return candidate.resourceId === runId;
    });
    expect(event?.data).toMatchObject({
      agent_id: firstAgentId,
      definition: {
        scorers: [{ type: 'contains', name: 'contains', value: 'refund' }],
        pass_threshold: 0.5,
        group_by: null,
      },
    });
  });

  test('a run keeps its agent_id after that agent is deleted', async () => {
    const doomedAgentId = await createAgent('Definition Doomed Agent');
    const evalId = await createEval({ agent_id: doomedAgentId });
    const started = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });
    expect(started.status).toBe(201);

    await updateEval(evalId, { agent_id: secondAgentId });
    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/agents/${doomedAgentId}`
    );
    expect(deleted.status).toBe(204);

    expect((await readRun(evalId, started.body.id)).agent_id).toBe(
      doomedAgentId
    );
  });

  test('a queued run whose agent was deleted fails instead of running another agent', async () => {
    const doomedAgentId = await createAgent('Definition Queued Doomed Agent');
    const evalId = await createEval({ agent_id: doomedAgentId });
    const runId = await startQueuedRun(evalId);

    await updateEval(evalId, { agent_id: secondAgentId });
    await authenticatedTestClient(adminToken).delete(
      `/api/v1/agents/${doomedAgentId}`
    );
    await drainEvalQueueOnce();

    expect(mockCreateGeneration).not.toHaveBeenCalled();
    const run = await readRun(evalId, runId);
    expect(run.status).toBe('failed');
    expect(run.agent_id).toBe(doomedAgentId);
    expect(run.error).toMatchObject({
      code: 'AGENT_NOT_FOUND',
      meta: { agent_id: doomedAgentId },
    });
  });

  test('a live run with no recorded definition fails rather than read its Eval', async () => {
    const evalId = await createEval();
    const runId = await startQueuedRun(evalId);
    await db.EvalRun.update(
      { definition: null },
      { where: { publicId: runId } }
    );

    await drainEvalQueueOnce();

    expect(mockCreateGeneration).not.toHaveBeenCalled();
    const run = await readRun(evalId, runId);
    expect(run.status).toBe('failed');
    expect(run.error.code).toBe('EVAL_RUN_DEFINITION_MISSING');
  });

  test('an item never moves back to running a run a sibling item settled', async () => {
    const evalId = await createEval();
    const runId = await startQueuedRun(evalId);
    await db.EvalRun.update(
      { definition: null },
      { where: { publicId: runId } }
    );

    // A sibling item fails the run after this item read it as queued.
    let siblingSettled = false;
    const settleBySibling = async (status: unknown) => {
      if (status !== 'running' || siblingSettled) return;
      siblingSettled = true;
      await db.EvalRun.update(
        { status: 'failed', finishedAt: new Date() },
        { where: { publicId: runId }, hooks: false }
      );
    };
    db.EvalRun.addHook('beforeUpdate', 'siblingSettles', (run) => {
      return settleBySibling(run.dataValues.status);
    });
    db.EvalRun.addHook('beforeBulkUpdate', 'siblingSettlesBulk', (options) => {
      const attributes = 'attributes' in options ? options.attributes : null;
      return settleBySibling(
        attributes && typeof attributes === 'object' && 'status' in attributes
          ? attributes.status
          : undefined
      );
    });
    try {
      await drainEvalQueueOnce({ limit: 1 });
    } finally {
      db.EvalRun.removeHook('beforeUpdate', 'siblingSettles');
      db.EvalRun.removeHook('beforeBulkUpdate', 'siblingSettlesBulk');
    }

    expect(siblingSettled).toBe(true);
    expect((await readRun(evalId, runId)).status).toBe('failed');
  });

  test('two items of a run whose agent was deleted, drained in parallel, leave it failed', async () => {
    // An earlier run's leftover task would take a slot of the two-task claim.
    await db.EvalRunTask.destroy({ where: {} });
    const doomedAgentId = await createAgent('Definition Parallel Doomed Agent');
    const evalId = await createEval({ agent_id: doomedAgentId });
    const runId = await startQueuedRun(evalId);
    // Deleting the agent the Eval still names would cascade the run away.
    await updateEval(evalId, { agent_id: secondAgentId });
    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/agents/${doomedAgentId}`
    );
    expect(deleted.status).toBe(204);

    // Hold the first item's `running` write until the other item failed the run.
    let releaseHeld: () => void = () => {};
    const failedWritten = new Promise<void>((resolve) => {
      releaseHeld = resolve;
      setTimeout(resolve, 5_000);
    });
    let held = false;
    const holdFirstStart = async (status: unknown) => {
      if (status !== 'running' || held) return;
      held = true;
      await failedWritten;
    };
    const statusOf = (options: object): unknown => {
      const attributes = 'attributes' in options ? options.attributes : null;
      return attributes &&
        typeof attributes === 'object' &&
        'status' in attributes
        ? attributes.status
        : undefined;
    };
    db.EvalRun.addHook('beforeUpdate', 'holdStart', (run) => {
      return holdFirstStart(run.dataValues.status);
    });
    db.EvalRun.addHook('beforeBulkUpdate', 'holdStartBulk', (options) => {
      return holdFirstStart(statusOf(options));
    });
    db.EvalRun.addHook('afterUpdate', 'releaseOnFailed', (run) => {
      if (run.dataValues.status === 'failed') releaseHeld();
    });
    try {
      expect(await drainEvalQueueOnce({ limit: 2 })).toBe(2);
    } finally {
      db.EvalRun.removeHook('beforeUpdate', 'holdStart');
      db.EvalRun.removeHook('beforeBulkUpdate', 'holdStartBulk');
      db.EvalRun.removeHook('afterUpdate', 'releaseOnFailed');
    }

    expect(held).toBe(true);
    expect(mockCreateGeneration).not.toHaveBeenCalled();
    expect((await readRun(evalId, runId)).status).toBe('failed');
  });

  describe('authentication and authorization', () => {
    let evalId: string;
    let runId: string;

    beforeAll(async () => {
      evalId = await createEval();
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });
      runId = res.body.id as string;
    });

    test('an unauthenticated run read returns 401', async () => {
      const res = await testClient.get(`/api/v1/evals/${evalId}/runs/${runId}`);
      expect(res.status).toBe(401);
    });

    // An eval the caller cannot read is not found, so its runs leak no field.
    test('a principal without GetEval gets 404 and no field of the run', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/evals/${evalId}/runs/${runId}`
      );
      expect(res.status).toBe(404);
      expect(res.body.agent_id).toBeUndefined();
      expect(res.body.definition).toBeUndefined();
    });
  });
});
