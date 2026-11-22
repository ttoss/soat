import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * `evidence.min_calibration` (the evaluations module doc — Evidence): a
 * claim's verdict reads `insufficient` until every externally graded scorer
 * agrees with enough human labels on a run of the version graded by the same
 * scorers. The run's own verdict never moves.
 */

type GenerationCall = { messages: Array<{ content: string }> };

const QUESTIONS = [
  {
    type: 'predicate',
    name: 'resolves_issue',
    instructions: 'Does the reply resolve what the customer asked?',
  },
];

// Every decision reads 0.8, so `pass_threshold: 0.7` passes every item.
const ANSWER = { answers: [{ name: 'resolves_issue', probability: 0.8 }] };

describe('Agent version claims — calibration evidence', () => {
  let stubServer: Server;
  let userToken: string;
  let userPolicyId: string;
  let adminToken: string;
  let projectId: string;
  let agentId: string;
  let datasetId: string;
  let deciderId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const deciderScorer = (extra: Record<string, unknown> = {}) => {
    return {
      type: 'decider',
      name: 'reply_review',
      decider_id: deciderId,
      score: { var: 'answers_by_name.resolves_issue.probability' },
      pass_threshold: 0.7,
      ...extra,
    };
  };

  const createEval = async (body: Record<string, unknown>) => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('calibrated-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        // 2 of 2 passing has an interval floor near 0.34, which clears 0.3.
        pass_threshold: 0.3,
        claim: { statement: 'Resolves refund requests.' },
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const run = async (evalId: string) => {
    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true });
    expect(res.status).toBe(201);
    expect(res.body.verdict).toBe('supported');
    return res.body.id as string;
  };

  const labelAll = async (evalId: string, runId: string, passed: boolean) => {
    const path = `/api/v1/evals/${evalId}/runs/${runId}/results`;
    const results = await asUser().get(path);
    for (const result of results.body.data as Array<{ id: string }>) {
      const res = await asUser()
        .put(`${path}/${result.id}/label`)
        .send({ passed });
      expect(res.status).toBe(200);
    }
  };

  const labelFirst = async (evalId: string, runId: string, passed: boolean) => {
    const path = `/api/v1/evals/${evalId}/runs/${runId}/results`;
    const results = await asUser().get(path);
    const [first] = results.body.data as Array<{ id: string }>;
    const res = await asUser()
      .put(`${path}/${first.id}/label`)
      .send({ passed });
    expect(res.status).toBe(200);
  };

  const claimOf = async (evalId: string) => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/agents/${agentId}/versions/1/claims`
    );
    expect(res.status).toBe(200);
    return (
      res.body.data as Array<{
        eval_id: string;
        verdict: string;
        verdict_reasons: Array<{
          scope: { kind: string; name?: string };
          verdict: string;
          reason: string;
        }>;
      }>
    ).find((claim) => {
      return claim.eval_id === evalId;
    });
  };

  const calibrationReason = (
    claim: Awaited<ReturnType<typeof claimOf>>,
    name: string
  ) => {
    return claim?.verdict_reasons.find((reason) => {
      return reason.scope.kind === 'calibration' && reason.scope.name === name;
    });
  };

  const MIN = { min_calibration: { labeled: 2, agreement: 0.5 } };

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
          content: 'refund issued',
          finishReason: 'stop' as const,
        },
      };
    });

    stubServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ANSWER));
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;

    const setup = await setupProjectWithUsers({
      prefix: 'evalcalibration',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:ListEvals',
        'evaluations:RunEval',
        'evaluations:LabelEvalResult',
        'agents:CreateAgentGeneration',
        'deciders:CreateDecider',
        'deciders:CreateDecision',
        'tools:CreateTool',
        'tools:CallTool',
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
        name: 'Calibration Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Calibration Agent',
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id as string;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'calibration-cases' });
    datasetId = dataset.body.id as string;
    for (const content of ['one', 'two']) {
      const item = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content }] });
      expect(item.status).toBe(201);
    }

    const tool = await asUser()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'review-engine',
        type: 'http',
        description: 'Answers a question set',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        execute: { url: `http://127.0.0.1:${port}/decide`, method: 'POST' },
      });
    expect(tool.status).toBe(201);
    const decider = await asUser()
      .post('/api/v1/deciders')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: 'reply-review',
        tool_id: tool.body.id,
        questions: QUESTIONS,
      });
    expect(decider.status).toBe(201);
    deciderId = decider.body.id as string;
  });

  afterAll(async () => {
    mockCreateGeneration.mockReset();
    delete process.env.EVAL_WORKER_DISABLED;
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  describe('the claim verdict reads calibration', () => {
    test('a scorer nobody labeled leaves the claim insufficient, the run supported', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      await run(evalId);

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(calibrationReason(claim, 'reply_review')).toMatchObject({
        verdict: 'insufficient',
        reason: '0 labeled, 2 required',
      });
    });

    test('enough agreeing labels on the speaking run support the claim', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      const runId = await run(evalId);
      await labelAll(evalId, runId, true);

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('supported');
      expect(calibrationReason(claim, 'reply_review')).toMatchObject({
        verdict: 'supported',
      });
    });

    test('labels the scorer disagrees with leave it insufficient', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      const runId = await run(evalId);
      await labelAll(evalId, runId, false);

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(calibrationReason(claim, 'reply_review')).toMatchObject({
        reason: 'agreement 0 below 0.5',
      });
    });

    test('labels of an earlier run of the version count while the scorers are the same', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      const first = await run(evalId);
      await labelAll(evalId, first, true);
      await run(evalId);

      expect((await claimOf(evalId))?.verdict).toBe('supported');
    });

    test('labels spread over runs graded by the same scorers add up', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      await labelFirst(evalId, await run(evalId), true);
      await labelFirst(evalId, await run(evalId), true);

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('supported');
      expect(calibrationReason(claim, 'reply_review')).toMatchObject({
        verdict: 'supported',
        reason: 'agreement 1 at or above 0.5',
      });
    });

    test('a run that agrees does not outweigh one that disagrees', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: { min_calibration: { labeled: 2, agreement: 0.6 } },
      });
      await labelAll(evalId, await run(evalId), true);
      await labelAll(evalId, await run(evalId), false);

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(calibrationReason(claim, 'reply_review')).toMatchObject({
        verdict: 'insufficient',
        reason: 'agreement 0.5 below 0.6',
      });
    });

    test('labels on a run that recorded no definition do not count', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      const first = await run(evalId);
      await labelAll(evalId, first, true);
      await db.EvalRun.update(
        { definition: null },
        { where: { publicId: first } }
      );
      await run(evalId);

      const claim = await claimOf(evalId);
      expect(calibrationReason(claim, 'reply_review')).toMatchObject({
        verdict: 'insufficient',
        reason: '0 labeled, 2 required',
      });
    });

    test('labels under other scorers stop counting once the scorers change', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      const first = await run(evalId);
      await labelAll(evalId, first, true);
      const edit = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ scorers: [deciderScorer({ pass_threshold: 0.6 })] });
      expect(edit.status).toBe(200);
      await run(evalId);

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(calibrationReason(claim, 'reply_review')).toMatchObject({
        reason: '0 labeled, 2 required',
      });
    });

    test('a calibration rule recorded on the run that does not read is insufficient, never ignored', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });
      const runId = await run(evalId);
      await labelAll(evalId, runId, true);
      const stored = await db.EvalRun.findOne({ where: { publicId: runId } });
      await stored!.update({
        definition: {
          ...stored!.definition,
          evidence: { min_calibration: { labeled: 0, agreement: 2 } },
        },
      });

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(calibrationReason(claim, 'unreadable')).toMatchObject({
        verdict: 'insufficient',
      });
    });

    test('an eval graded only by pure scorers needs no calibration', async () => {
      const evalId = await createEval({
        scorers: [{ type: 'contains', value: 'refund' }],
        evidence: MIN,
      });
      await run(evalId);

      const claim = await claimOf(evalId);
      expect(claim?.verdict).toBe('supported');
      expect(
        claim?.verdict_reasons.some((reason) => {
          return reason.scope.kind === 'calibration';
        })
      ).toBe(false);
    });
  });

  describe('POST /api/v1/evals with evidence.min_calibration', () => {
    test.each([
      ['labeled 0', { labeled: 0, agreement: 0.9 }],
      ['agreement above 1', { labeled: 30, agreement: 2 }],
      ['no agreement', { labeled: 30 }],
      ['an unknown key', { labeled: 30, agreement: 0.9, kappa: 0.8 }],
      ['a non-object', 30],
      ['null', null],
    ])('refuses %s with 400', async (_label, rule) => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          policy_ids: [userPolicyId],
          project_id: projectId,
          name: unique('bad-calibration'),
          agent_id: agentId,
          dataset_id: datasetId,
          pass_threshold: 0.5,
          scorers: [deciderScorer()],
          evidence: { min_calibration: rule },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PUT /api/v1/evals/{eval_id} with evidence.min_calibration', () => {
    test('refuses a malformed rule with 400 and keeps the stored one', async () => {
      const evalId = await createEval({
        scorers: [deciderScorer()],
        evidence: MIN,
      });

      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ evidence: { min_calibration: { labeled: 2 } } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const stored = await asUser().get(`/api/v1/evals/${evalId}`);
      expect(stored.body.evidence).toMatchObject(MIN);
    });
  });
});
