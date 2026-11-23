import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * `criteria` on an eval (the evaluations module doc — Criteria): every scorer
 * sits in exactly one criterion, each criterion is defined by probes that
 * pass and fail, and a run judges each criterion on its own interval.
 */

type GenerationCall = { messages: Array<{ content: string }> };

const SCORERS = [
  { type: 'contains', name: 'mentions_refund', value: 'refund' },
  { type: 'contains', name: 'mentions_policy', value: 'policy' },
  { type: 'contains', name: 'mentions_cancel', value: 'cancel' },
];

const probes = [
  { output: 'Your refund policy applies.', passed: true },
  { output: 'Hello.', passed: false, note: 'says nothing' },
];

const CRITERIA = [
  {
    name: 'explains_refund',
    description: 'Names the refund and the policy behind it',
    scorers: ['mentions_refund', 'mentions_policy'],
    probes,
  },
  {
    name: 'offers_cancellation',
    description: 'Offers to cancel the order',
    scorers: ['mentions_cancel'],
    probes: [
      { output: 'I can cancel it.', passed: true },
      { output: 'Your refund policy applies.', passed: false },
    ],
  },
];

describe('Evaluations — criteria', () => {
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

  const createEval = (extra: Record<string, unknown>) => {
    return asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('criteria-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: SCORERS,
        // 2 of 2 passing has an interval floor near 0.34, which clears 0.3.
        pass_threshold: 0.3,
        ...extra,
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
          content: 'Your refund policy applies.',
          finishReason: 'stop' as const,
        },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'evalcriteria',
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
        name: 'Criteria Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Criteria Agent',
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id as string;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'criteria-cases' });
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

  describe('POST /api/v1/evals', () => {
    test('stores the criteria and reads them back', async () => {
      const res = await createEval({ criteria: CRITERIA });
      expect(res.status).toBe(201);
      expect(res.body.criteria).toEqual(CRITERIA);

      const read = await asUser().get(`/api/v1/evals/${res.body.id}`);
      expect(read.body.criteria).toEqual(CRITERIA);
    });

    test('an eval without criteria reads null', async () => {
      const res = await createEval({});
      expect(res.status).toBe(201);
      expect(res.body.criteria).toBeNull();
    });

    const [explains, offers] = CRITERIA;
    test.each([
      [
        'a scorer in no criterion',
        [{ ...explains, scorers: ['mentions_refund'] }, offers],
        /mentions_policy/,
      ],
      [
        'a scorer in two criteria',
        [
          explains,
          { ...offers, scorers: ['mentions_cancel', 'mentions_refund'] },
        ],
        /mentions_refund/,
      ],
      [
        'an unknown scorer',
        [explains, { ...offers, scorers: ['mentions_cancel', 'nope'] }],
        /nope/,
      ],
      [
        'a criterion naming no scorer',
        [explains, offers, { ...offers, name: 'empty', scorers: [] }],
        /criteria\.2\.scorers/,
      ],
      [
        'two criteria sharing a name',
        [explains, { ...offers, name: 'explains_refund' }],
        /criteria\.1\.name/,
      ],
      [
        'no failing probe',
        [{ ...explains, probes: [probes[0]] }, offers],
        /criteria\.0\.probes/,
      ],
      [
        'no passing probe',
        [{ ...explains, probes: [probes[1]] }, offers],
        /criteria\.0\.probes/,
      ],
      [
        'a probe without an output',
        [{ ...explains, probes: [{ passed: true }, probes[1]] }, offers],
        /criteria\.0\.probes\.0\.output/,
      ],
      [
        'a probe whose passed is not a boolean',
        [
          { ...explains, probes: [{ output: 'x', passed: 'yes' }, probes[1]] },
          offers,
        ],
        /criteria\.0\.probes\.0\.passed/,
      ],
    ])('refuses %s with 400', async (_label, criteria, message) => {
      const res = await createEval({ criteria });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(message as RegExp);
    });
  });

  describe('PUT /api/v1/evals/{eval_id}', () => {
    test('replaces the criteria, keeps them when omitted, clears them with null', async () => {
      const created = await createEval({ criteria: CRITERIA });
      const path = `/api/v1/evals/${created.body.id}`;
      const merged = [
        {
          ...CRITERIA[0],
          scorers: SCORERS.map((s) => {
            return s.name;
          }),
        },
      ];

      const replaced = await asUser().put(path).send({ criteria: merged });
      expect(replaced.status).toBe(200);
      expect(replaced.body.criteria).toEqual(merged);

      const kept = await asUser().put(path).send({ pass_threshold: 0.4 });
      expect(kept.body.criteria).toEqual(merged);

      const cleared = await asUser().put(path).send({ criteria: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.criteria).toBeNull();
    });

    test('refuses scorers that leave a stored criterion naming a missing scorer', async () => {
      const created = await createEval({ criteria: CRITERIA });
      const res = await asUser()
        .put(`/api/v1/evals/${created.body.id}`)
        .send({ scorers: SCORERS.slice(0, 2) });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/mentions_cancel/);
    });

    test('returns 401 without a credential', async () => {
      const created = await createEval({ criteria: CRITERIA });
      const res = await testClient
        .put(`/api/v1/evals/${created.body.id}`)
        .send({ criteria: null });
      expect(res.status).toBe(401);
    });
  });

  describe('a run of an eval with criteria', () => {
    test('copies the criteria and judges each on its own interval', async () => {
      const created = await createEval({ criteria: CRITERIA });
      const res = await asUser()
        .post(`/api/v1/evals/${created.body.id}/runs`)
        .send({ wait: true });
      expect(res.status).toBe(201);

      expect(res.body.definition.criteria).toEqual(CRITERIA);
      expect(res.body.aggregate_scores.criteria).toMatchObject({
        explains_refund: { pass_rate: 1, scored_item_count: 2 },
        offers_cancellation: { pass_rate: 0, scored_item_count: 2 },
      });
      expect(res.body.verdict_reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: { kind: 'criterion', name: 'explains_refund' },
            verdict: 'supported',
          }),
          expect.objectContaining({
            scope: { kind: 'criterion', name: 'offers_cancellation' },
            verdict: 'insufficient',
          }),
        ])
      );
    });

    test('a run of an eval without criteria reports none', async () => {
      const created = await createEval({});
      const res = await asUser()
        .post(`/api/v1/evals/${created.body.id}/runs`)
        .send({ wait: true });
      expect(res.status).toBe(201);
      expect(res.body.aggregate_scores.criteria).toBeUndefined();
      expect(
        (res.body.verdict_reasons as Array<{ scope: { kind: string } }>).some(
          (reason) => {
            return reason.scope.kind === 'criterion';
          }
        )
      ).toBe(false);
    });
  });
});
