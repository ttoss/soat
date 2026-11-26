import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { pollUntil } from '../../fixtures/poll';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * An eval states the claim its runs test (`statement`, `population`,
 * `limits`), and each run copies it at creation: a run reports the claim it
 * tested, never the eval's current wording.
 */

type GenerationCall = { messages: Array<{ content: string }> };

const CLAIM = {
  statement: 'The agent answers refund questions correctly.',
  population: 'Refund requests from retail customers in 2026',
  limits: ['English only', 'No escalations to a human'],
};

describe('Evaluations — the claim', () => {
  let adminToken: string;
  let userToken: string;
  let userPolicyId: string;
  let noPermToken: string;
  let projectId: string;
  let agentId: string;
  let datasetId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const postEval = (body: Record<string, unknown> = {}) => {
    return asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('claim-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', name: 'contains', value: 'refund' }],
        pass_threshold: 0.5,
        ...body,
      });
  };

  const createEval = async (body: Record<string, unknown> = {}) => {
    const res = await postEval(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const updateEval = async (evalId: string, body: Record<string, unknown>) => {
    const res = await asUser().put(`/api/v1/evals/${evalId}`).send(body);
    expect(res.status).toBe(200);
    return res.body;
  };

  const startRun = async (evalId: string, wait: boolean) => {
    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait });
    expect(res.status).toBe(201);
    return res.body;
  };

  const readRun = async (evalId: string, runId: string) => {
    const res = await asUser().get(`/api/v1/evals/${evalId}/runs/${runId}`);
    expect(res.status).toBe(200);
    return res.body;
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
      prefix: 'evalclaim',
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

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Claim Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Claim Agent',
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'claim-cases' });
    datasetId = dataset.body.id;
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

  describe('on the eval', () => {
    test('is stored, read back, kept when absent and cleared by null', async () => {
      const created = await postEval({ claim: CLAIM });
      expect(created.status).toBe(201);
      expect(created.body.claim).toEqual(CLAIM);

      const renamed = await updateEval(created.body.id, {
        name: unique('claim-renamed'),
      });
      expect(renamed.claim).toEqual(CLAIM);

      const cleared = await updateEval(created.body.id, { claim: null });
      expect(cleared.claim).toBeNull();
    });

    test('an eval created without one reads claim null', async () => {
      const res = await postEval();
      expect(res.status).toBe(201);
      expect(res.body.claim).toBeNull();
    });

    test('a statement alone leaves population and limits null', async () => {
      const res = await postEval({ claim: { statement: CLAIM.statement } });
      expect(res.status).toBe(201);
      expect(res.body.claim).toEqual({
        statement: CLAIM.statement,
        population: null,
        limits: null,
      });
    });

    test('an update replaces the whole claim', async () => {
      const evalId = await createEval({ claim: CLAIM });
      const updated = await updateEval(evalId, {
        claim: { statement: 'Another statement.' },
      });
      expect(updated.claim).toEqual({
        statement: 'Another statement.',
        population: null,
        limits: null,
      });
    });

    test.each([
      ['no statement', { population: 'p' }],
      ['an empty statement', { statement: '  ' }],
      ['a non-string statement', { statement: 3 }],
      ['an empty population', { statement: 's', population: '' }],
      ['limits that are not an array', { statement: 's', limits: 'English' }],
      ['an empty limit', { statement: 's', limits: ['English', ''] }],
      ['an unknown key', { statement: 's', confidence: 'high' }],
      ['a non-object', ['s']],
    ])('is refused with %s', async (_label, claim) => {
      const res = await postEval({ claim });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an update with an invalid claim is refused', async () => {
      const evalId = await createEval({ claim: CLAIM });
      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ claim: { statement: '' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('round-trips through a formation template', async () => {
      const create = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: unique('claim-stack'),
          template: {
            resources: {
              Gate: {
                type: 'eval',
                properties: {
                  policy_ids: [userPolicyId],
                  name: unique('claim-formation-eval'),
                  agent_id: agentId,
                  dataset_id: datasetId,
                  scorers: [
                    { type: 'contains', name: 'contains', value: 'refund' },
                  ],
                  claim: CLAIM,
                },
              },
            },
          },
        });
      expect(create.status).toBe(201);

      const evalId = (
        create.body.resources as Array<{ physical_resource_id: string }>
      )[0].physical_resource_id;
      const evaluation = await asUser().get(`/api/v1/evals/${evalId}`);
      expect(evaluation.status).toBe(200);
      expect(evaluation.body.claim).toEqual(CLAIM);
    });

    test('a formation template with an unknown claim key fails to apply', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: unique('claim-stack-bad'),
          template: {
            resources: {
              Gate: {
                type: 'eval',
                properties: {
                  policy_ids: [userPolicyId],
                  name: unique('claim-formation-bad'),
                  agent_id: agentId,
                  dataset_id: datasetId,
                  scorers: [
                    { type: 'contains', name: 'contains', value: 'refund' },
                  ],
                  claim: { statement: 's', confidence: 'high' },
                },
              },
            },
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'claim.confidence is not a known field.',
      });
    });
  });

  describe('on the run', () => {
    test('start, get and list return the claim the run was created with', async () => {
      const evalId = await createEval({ claim: CLAIM });
      const run = await startRun(evalId, true);
      expect(run.claim).toEqual(CLAIM);
      expect((await readRun(evalId, run.id)).claim).toEqual(CLAIM);

      const list = await asUser().get(`/api/v1/evals/${evalId}/runs`);
      expect(list.status).toBe(200);
      expect(list.body.data[0].claim).toEqual(CLAIM);
    });

    test('an edit to the eval reaches only runs created after it', async () => {
      const evalId = await createEval({ claim: CLAIM });
      const before = await startRun(evalId, true);
      await updateEval(evalId, { claim: { statement: 'Edited.' } });
      const after = await startRun(evalId, true);

      expect((await readRun(evalId, before.id)).claim).toEqual(CLAIM);
      expect((await readRun(evalId, after.id)).claim).toEqual({
        statement: 'Edited.',
        population: null,
        limits: null,
      });
    });

    test('a queued run keeps the claim it started with through an edit', async () => {
      const evalId = await createEval({ claim: CLAIM });
      const queued = await startRun(evalId, false);
      expect(queued.status).toBe('queued');

      await updateEval(evalId, { claim: null });
      await drainEvalQueueOnce();

      const run = await readRun(evalId, queued.id);
      expect(run.status).toBe('completed');
      expect(run.claim).toEqual(CLAIM);
    });

    test('a run of an eval with no claim reads claim null', async () => {
      const evalId = await createEval();
      const run = await startRun(evalId, true);
      expect(run.claim).toBeNull();
    });

    test('the eval_runs.completed payload carries the claim', async () => {
      const evalId = await createEval({ claim: CLAIM });
      const captured: SoatEvent[] = [];
      const handler = (event: SoatEvent) => {
        if (event.type === 'eval_runs.completed') captured.push(event);
      };
      eventBus.on('soat:event', handler);
      let runId = '';
      try {
        runId = (await startRun(evalId, true)).id as string;
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
      expect(event?.data).toMatchObject({ claim: CLAIM });
    });
  });

  describe('authentication and authorization', () => {
    let evalId: string;

    beforeAll(async () => {
      evalId = await createEval({ claim: CLAIM });
    });

    test('an unauthenticated eval read returns 401', async () => {
      const res = await testClient.get(`/api/v1/evals/${evalId}`);
      expect(res.status).toBe(401);
    });

    test('a principal without GetEval reads no claim', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/evals/${evalId}`
      );
      expect(res.status).toBe(404);
      expect(res.body.claim).toBeUndefined();
    });

    test('a principal without CreateEval cannot write a claim', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/evals/${evalId}`)
        .send({ claim: { statement: 'Hijacked.' } });
      expect(res.status).toBe(404);
      expect(
        (await asUser().get(`/api/v1/evals/${evalId}`)).body.claim
      ).toEqual(CLAIM);
    });
  });
});
