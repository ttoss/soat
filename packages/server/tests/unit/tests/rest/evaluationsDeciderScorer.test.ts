import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * The `decider` scorer (the evaluations module doc — Decider scorers): each
 * item is graded by a decision of a project decider, pinned at run start to
 * the decider version the run was started under.
 */

const levels = (labels: string[]) => {
  return labels.map((label) => {
    return { label, description: `The reply reads ${label.toLowerCase()}.` };
  });
};

const QUESTIONS = [
  {
    type: 'predicate',
    name: 'resolves_issue',
    instructions: 'Does the reply resolve what the customer asked?',
  },
  {
    type: 'score',
    name: 'tone',
    instructions: 'How warm is the reply?',
    levels: levels(['Cold', 'Neutral', 'Warm']),
  },
];

const ANSWER = {
  answers: [
    { name: 'resolves_issue', probability: 0.8 },
    {
      name: 'tone',
      score: 2,
      probabilities: [
        { value: 2, probability: 0.7 },
        { value: 1, probability: 0.3 },
      ],
    },
  ],
};

const RESOLVES_SCORE = {
  var: 'answers_by_name.resolves_issue.probability',
};

type Reply = { status?: number; body: unknown };

describe('Evaluations — decider scorers', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  const received: Array<Record<string, unknown>> = [];
  const replies: Reply[] = [];

  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let agentId: string;
  let datasetId: string;
  let deciderToolId: string;
  let deciderId: string;
  let otherProjectDeciderId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const completedGeneration = (id: string, content: string) => {
    return {
      id,
      traceId: `trc_${id}`,
      status: 'completed' as const,
      output: { model: 'test-model', content, finishReason: 'stop' },
    };
  };

  const deciderScorer = (extra: Record<string, unknown> = {}) => {
    return {
      type: 'decider',
      name: 'reply_review',
      decider_id: deciderId,
      score: RESOLVES_SCORE,
      pass_threshold: 0.7,
      ...extra,
    };
  };

  const postEval = (scorers: unknown[], token = userToken) => {
    return authenticatedTestClient(token)
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: unique('decider-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers,
      });
  };

  const createEval = async (scorers: unknown[]): Promise<string> => {
    const res = await postEval(scorers);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createDecider = async (body: Record<string, unknown> = {}) => {
    const res = await asUser()
      .post('/api/v1/deciders')
      .send({
        project_id: projectId,
        name: unique('reply-review'),
        tool_id: deciderToolId,
        questions: QUESTIONS,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const runEval = (evalId: string, body: Record<string, unknown> = {}) => {
    return asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true, ...body });
  };

  const resultsOf = async (evalId: string, runId: string) => {
    const res = await asUser().get(
      `/api/v1/evals/${evalId}/runs/${runId}/results`
    );
    expect(res.status).toBe(200);
    return res.body.data as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    process.env.EVAL_WORKER_DISABLED = 'true';

    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk as string;
      });
      req.on('end', () => {
        received.push(JSON.parse(raw) as Record<string, unknown>);
        const reply = replies.shift() ?? { body: ANSWER };
        res.writeHead(reply.status ?? 200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    stubBaseUrl = `http://127.0.0.1:${port}`;

    const setup = await setupProjectWithUsers({
      prefix: 'evaldecider',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:GetDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:ListEvals',
        'evaluations:RunEval',
        'deciders:CreateDecider',
        'deciders:UpdateDecider',
        'deciders:DeleteDecider',
        'deciders:GetDecision',
        'deciders:ListDecisions',
        'tools:CreateTool',
        'tools:UpdateTool',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Decider Scorer Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'Support Replier',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    const datasetRes = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'support-replies' });
    expect(datasetRes.status).toBe(201);
    datasetId = datasetRes.body.id;
    const itemRes = await asUser()
      .post(`/api/v1/datasets/${datasetId}/items`)
      .send({
        input: [{ role: 'user', content: 'I was charged twice.' }],
        expected_output: 'A refund of the duplicate charge.',
        metadata: { topic: 'billing' },
      });
    expect(itemRes.status).toBe(201);

    const toolRes = await asUser()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'reply-review-engine',
        type: 'http',
        description: 'Answers a question set',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        execute: { url: `${stubBaseUrl}/decide`, method: 'POST' },
      });
    expect(toolRes.status).toBe(201);
    deciderToolId = toolRes.body.id;
    deciderId = await createDecider();

    const otherToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: otherProjectId,
        name: 'other-engine',
        type: 'http',
        execute: { url: `${stubBaseUrl}/decide`, method: 'POST' },
      });
    const otherDeciderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/deciders')
      .send({
        project_id: otherProjectId,
        name: 'other-review',
        tool_id: otherToolRes.body.id,
        questions: QUESTIONS,
      });
    expect(otherDeciderRes.status).toBe(201);
    otherProjectDeciderId = otherDeciderRes.body.id;
  });

  afterAll(async () => {
    delete process.env.EVAL_WORKER_DISABLED;
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    received.length = 0;
    replies.length = 0;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await db.EvalRunTask.destroy({ where: {}, truncate: true });
  });

  describe('POST /api/v1/evals with a decider scorer', () => {
    test('stores the scorer as written', async () => {
      const res = await postEval([deciderScorer()]);
      expect(res.status).toBe(201);
      expect(res.body.scorers).toEqual([deciderScorer()]);
    });

    test('returns 401 without a credential', async () => {
      const res = await testClient
        .post('/api/v1/evals')
        .send({ project_id: projectId, scorers: [deciderScorer()] });
      expect(res.status).toBe(401);
    });

    test('returns 403 without evaluations:CreateEval', async () => {
      const res = await postEval([deciderScorer()], noPermToken);
      expect(res.status).toBe(403);
    });

    test.each([
      ['a missing score', { score: undefined }, 'scorers.0.score'],
      [
        'a missing pass_threshold',
        { pass_threshold: undefined },
        'scorers.0.pass_threshold',
      ],
      ['a pass_threshold above 1', { pass_threshold: 2 }, 'pass_threshold'],
      ['a missing decider_id', { decider_id: undefined }, 'decider_id'],
      ['a missing name', { name: undefined }, 'scorers.0.name'],
      ['a built-in type as name', { name: 'llm_judge' }, 'built-in'],
      ['an unknown field', { tool_id: 'tool_x' }, 'unknown field'],
    ])('refuses %s', async (_label, extra, message) => {
      const res = await postEval([deciderScorer(extra)]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain(message);
    });

    test('refuses a name another scorer already keys', async () => {
      const res = await postEval([
        deciderScorer(),
        { ...deciderScorer(), name: 'reply_review' },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('more than once');
    });

    test('refuses a decider outside the eval project', async () => {
      const res = await postEval([
        deciderScorer({ decider_id: otherProjectDeciderId }),
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain(otherProjectDeciderId);
    });

    test('refuses a decider that does not exist', async () => {
      const res = await postEval([deciderScorer({ decider_id: 'dcd_nope' })]);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('dcd_nope');
    });
  });

  describe('POST /api/v1/evals/{eval_id}/runs with a decider scorer', () => {
    test('grades each item with a decision and records it', async () => {
      const evalId = await createEval([deciderScorer()]);
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc1', 'Refund issued for the duplicate.')
      );

      const res = await runEval(evalId);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');
      expect(res.body.errored_count).toBe(0);
      expect(res.body.decider_versions).toEqual({ reply_review: 1 });
      expect(res.body.aggregate_scores.scorers.reply_review).toEqual({
        mean: 0.8,
        pass_rate: 1,
      });

      // With no `input`, the decision judges the item context a json_logic
      // scorer reads.
      expect(received).toEqual([
        {
          input: {
            input: [{ role: 'user', content: 'I was charged twice.' }],
            output: 'Refund issued for the duplicate.',
            expected: 'A refund of the duplicate charge.',
            item: { metadata: { topic: 'billing' } },
          },
          questions: QUESTIONS,
        },
      ]);

      const [result] = await resultsOf(evalId, res.body.id);
      const [outcome] = result.scores as Array<Record<string, unknown>>;
      expect(outcome).toEqual({
        scorer: 'reply_review',
        score: 0.8,
        passed: true,
        decision_id: expect.stringMatching(/^dec_/),
      });

      const decision = await asUser().get(
        `/api/v1/decisions/${outcome.decision_id}`
      );
      expect(decision.status).toBe(200);
      expect(decision.body).toMatchObject({
        decider_id: deciderId,
        decider_version: 1,
        status: 'completed',
        metadata: {
          eval_id: evalId,
          eval_run_id: res.body.id,
          dataset_item_id: result.dataset_item_id,
        },
      });
    });

    test('judges the input the scorer maps from the item context', async () => {
      const evalId = await createEval([
        deciderScorer({
          input: {
            customer: { var: 'input.0.content' },
            reply: { var: 'output' },
          },
        }),
      ]);
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc2', 'Refund issued.')
      );

      const res = await runEval(evalId);

      expect(res.status).toBe(201);
      expect(received[0]?.input).toEqual({
        customer: 'I was charged twice.',
        reply: 'Refund issued.',
      });
    });

    test('fails the item below pass_threshold', async () => {
      const evalId = await createEval([deciderScorer({ pass_threshold: 0.9 })]);
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc3', 'Maybe.')
      );

      const res = await runEval(evalId);

      const [result] = await resultsOf(evalId, res.body.id);
      expect(result.passed).toBe(false);
      expect(result.scores).toEqual([
        expect.objectContaining({ score: 0.8, passed: false }),
      ]);
    });

    test('a failed decision errors the item, never scores it 0', async () => {
      const evalId = await createEval([deciderScorer()]);
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc4', 'Refund issued.')
      );
      replies.push({
        body: { answers: [{ name: 'resolves_issue', probability: 0.9 }] },
      });

      const res = await runEval(evalId);

      expect(res.body.errored_count).toBe(1);
      const [result] = await resultsOf(evalId, res.body.id);
      expect(result.output).toBe('Refund issued.');
      expect(result.error).toContain("scorer 'reply_review'");
      expect(result.error).toContain('DECISION_ANSWER_INVALID');
      expect(result.error).toMatch(/dec_\w+/);
    });

    test('a decision refused at admission errors the item, naming the scorer', async () => {
      const toolRes = await asUser()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: unique('soon-uncallable'),
          type: 'http',
          execute: { url: `${stubBaseUrl}/decide`, method: 'POST' },
        });
      const refused = await createDecider({ tool_id: toolRes.body.id });
      const evalId = await createEval([deciderScorer({ decider_id: refused })]);
      const pin = await asUser()
        .patch(`/api/v1/tools/${toolRes.body.id}`)
        .send({ preset_parameters: { input: 'fixed' } });
      expect(pin.status).toBe(200);
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc8', 'Refund issued.')
      );

      const res = await runEval(evalId);

      expect(res.body.errored_count).toBe(1);
      const [result] = await resultsOf(evalId, res.body.id);
      expect(result.error).toContain("scorer 'reply_review'");
      expect(result.error).toContain('pins input');
      expect(received).toHaveLength(0);
    });

    test('a score expression outside 0–1 errors the item', async () => {
      const evalId = await createEval([
        deciderScorer({ score: { var: 'answers_by_name.tone.score' } }),
      ]);
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc5', 'Refund issued.')
      );

      const res = await runEval(evalId);

      expect(res.body.errored_count).toBe(1);
      const [result] = await resultsOf(evalId, res.body.id);
      expect(result.error).toContain('between 0 and 1');
    });

    test('a decider deleted since the eval was written refuses the run', async () => {
      const doomed = await createDecider();
      const evalId = await createEval([deciderScorer({ decider_id: doomed })]);
      const del = await asUser().delete(`/api/v1/deciders/${doomed}`);
      expect(del.status).toBe(204);

      const res = await runEval(evalId);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain(doomed);
    });

    test('a queued run grades every item under the version it started with', async () => {
      const pinned = await createDecider();
      const evalId = await createEval([deciderScorer({ decider_id: pinned })]);

      const start = await runEval(evalId, { wait: false });
      expect(start.status).toBe(201);
      expect(start.body.decider_versions).toEqual({ reply_review: 1 });

      const reworded = [
        QUESTIONS[0],
        { ...QUESTIONS[1], levels: levels(['Hostile', 'Flat', 'Kind']) },
      ];
      const update = await asUser()
        .patch(`/api/v1/deciders/${pinned}`)
        .send({ questions: reworded });
      expect(update.body.version).toBe(2);

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc6', 'Refund issued.')
      );
      expect(await drainEvalQueueOnce()).toBe(1);

      expect(received[0]?.questions).toEqual(QUESTIONS);
      const [result] = await resultsOf(evalId, start.body.id);
      const [outcome] = result.scores as Array<Record<string, unknown>>;
      const decision = await asUser().get(
        `/api/v1/decisions/${outcome.decision_id}`
      );
      expect(decision.body.decider_version).toBe(1);
      expect(decision.body.answers_by_name.tone.probabilities).toEqual([
        { value: 2, label: 'Warm', probability: 0.7 },
        { value: 1, label: 'Neutral', probability: 0.3 },
      ]);
    });

    test('a run with no decider scorer pins no decider version', async () => {
      const evalId = await createEval([{ type: 'exact_match' }]);
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_dsc7', 'A refund of the duplicate charge.')
      );

      const res = await runEval(evalId);

      expect(res.status).toBe(201);
      expect(res.body.decider_versions).toBeNull();
    });
  });
});
