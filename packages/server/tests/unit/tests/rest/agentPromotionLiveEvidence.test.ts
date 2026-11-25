import { app } from 'src/app';
import { db } from 'src/db';
import request from 'supertest';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A claim's verdict reads production beside its run (the evaluations module
 * doc — Evidence): the version's served generations, their failures, the
 * guardrail tripwires and approval rejections linked to them, and the run's
 * age. The run's own verdict never moves; the claims read, the gate and the
 * pawl on promotion read the claim verdict. Promotion records the claims it
 * stood on. The rules' boundaries are `lib/claimLiveEvidence.test.ts`.
 *
 * Production rows are written straight to the tables, as `agents.test.ts`
 * does: hundreds of real generations per case are not a fixture an API call
 * can produce.
 */

type Message = { role: string; content: string };
type Reason = { scope: { kind: string; name?: string }; verdict: string };

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Agent version claims — live evidence', () => {
  let adminToken: string;
  let userToken: string;
  let userPolicyId: string;
  let projectId: string;
  let projectDbId: number;
  let providerId: string;
  let datasetId: string;
  let answer = 'Paris';
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createTwoVersionAgent = async (): Promise<string> => {
    const agent = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerId,
        name: unique('live-agent'),
        instructions: 'stable prompt',
      });
    expect(agent.status).toBe(201);
    const edit = await asAdmin()
      .put(`/api/v1/agents/${agent.body.id}`)
      .send({ instructions: 'canary prompt' });
    expect(edit.status).toBe(200);
    return agent.body.id as string;
  };

  const postEval = (agentId: string, evidence: unknown) => {
    return asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('live-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', name: 'contains', value: 'Paris' }],
        pass_threshold: 0.5,
        claim: { statement: 'Names capitals.' },
        evidence,
      });
  };

  const createEval = async (agentId: string, evidence: unknown) => {
    const res = await postEval(agentId, evidence);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** A run answering `Paris` is supported; one answering `Lyon` is refuted. */
  const run = async (args: {
    evalId: string;
    version: number;
    reply?: 'Paris' | 'Lyon';
  }) => {
    answer = args.reply ?? 'Paris';
    const res = await asUser()
      .post(`/api/v1/evals/${args.evalId}/runs`)
      .send({ wait: true, agent_version: args.version });
    expect(res.status).toBe(201);
    expect(res.body.verdict).toBe(answer === 'Paris' ? 'supported' : 'refuted');
    return res.body as { id: string };
  };

  /** Production generations of one version, as the served path writes them. */
  const serve = async (args: {
    agentId: string;
    version: number;
    count: number;
    status?: 'completed' | 'failed' | 'running' | 'requires_action';
    source?: string | null;
    startedAt?: Date;
  }): Promise<string[]> => {
    const agent = await db.Agent.findOne({ where: { publicId: args.agentId } });
    const trace = await db.Trace.create({
      projectId: projectDbId,
      agentId: agent!.id as number,
      agentPublicId: args.agentId,
    });
    const ids: string[] = [];
    for (let index = 0; index < args.count; index += 1) {
      const startedAt = args.startedAt ?? new Date();
      const generation = await db.Generation.create({
        projectId: projectDbId,
        agentId: agent!.id as number,
        agentPublicId: args.agentId,
        traceId: trace.id as number,
        agentVersion: args.version,
        status: args.status ?? 'completed',
        source: args.source ?? null,
        startedAt,
        completedAt: startedAt,
      });
      ids.push(generation.publicId);
    }
    return ids;
  };

  const tripwire = async (generationId: string) => {
    await db.GuardrailEvaluation.create({
      projectId: projectDbId,
      guardrailId: 'grd_live_evidence',
      scope: 'agent',
      resolvedClass: 'B',
      decision: 'tripwire',
      contextSource: 'none',
      contextSnapshot: {},
      generationId,
    });
  };

  const approval = async (generationId: string, status: string) => {
    await db.ApprovalItem.create({
      projectId: projectDbId,
      origin: 'tool_call',
      status,
      proposedAction: { tool: 'noop' },
      expiresAt: new Date(Date.now() + 60_000),
      generationId,
    });
  };

  const claimOf = async (agentId: string, version: number, evalId: string) => {
    const res = await asAdmin().get(
      `/api/v1/agents/${agentId}/versions/${version}/claims`
    );
    expect(res.status).toBe(200);
    return (
      res.body.data as Array<{
        eval_id: string;
        verdict: string;
        verdict_reasons: Reason[];
      }>
    ).find((claim) => {
      return claim.eval_id === evalId;
    });
  };

  const liveReason = (reasons: Reason[], name: string) => {
    return reasons.find((reason) => {
      return reason.scope.kind === 'live' && reason.scope.name === name;
    });
  };

  const release = (agentId: string, body: Record<string, unknown> = {}) => {
    return asAdmin()
      .put(`/api/v1/agents/${agentId}/release`)
      .send({
        stable_version: 1,
        canary_version: 2,
        canary_percent: 50,
        ...body,
      });
  };

  const promote = (agentId: string) => {
    return asAdmin().post(`/api/v1/agents/${agentId}/release/promote`);
  };

  beforeAll(async () => {
    mockCreateGeneration.mockImplementation(async (args) => {
      const content = (args.messages as Message[])[0]!.content;
      return {
        id: `gen_${content}_${unique('g')}`,
        traceId: `trc_${content}_${unique('t')}`,
        status: 'completed' as const,
        output: { model: 'test-model', content: answer, finishReason: 'stop' },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'liveevidence',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:GetDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:RunEval',
        'agents:CreateAgentGeneration',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userPolicyId = setup.policyId;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectDbId = project!.id as number;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Live Provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
    providerId = provider.body.id;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'live-evidence-dataset' });
    expect(dataset.status).toBe(201);
    datasetId = dataset.body.id;
    for (let index = 0; index < 4; index += 1) {
      const item = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content: `capital-${index}` }] });
      expect(item.status).toBe(201);
    }
  });

  afterAll(() => {
    mockCreateGeneration.mockReset();
  });

  describe('evidence.live and evidence.max_run_age_days on the eval', () => {
    test('are stored, read back and copied onto the run', async () => {
      const agentId = await createTwoVersionAgent();
      const evidence = {
        live: {
          window: '30d',
          min_served_generations: 2,
          guardrail_tripwires: { max: 0 },
          approval_rejections: { max_rate: 0.05, min_decided: 20 },
          generation_failures: { max_rate: 0.01 },
        },
        max_run_age_days: 30,
      };
      const evalId = await createEval(agentId, evidence);

      const read = await asUser().get(`/api/v1/evals/${evalId}`);
      expect(read.body.evidence).toEqual(evidence);
      const created = await run({ evalId, version: 2 });
      const runRead = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${created.id}`
      );
      expect(runRead.body.definition.evidence).toEqual(evidence);
    });

    test.each([
      ['live without window', { live: { guardrail_tripwires: { max: 0 } } }],
      ['an unknown live rule', { live: { window: '7d', exceptions: {} } }],
      [
        'a rejection rate without min_decided',
        { live: { window: '7d', approval_rejections: { max_rate: 0.1 } } },
      ],
      ['max_run_age_days 0', { max_run_age_days: 0 }],
    ])('is refused with %s', async (_label, evidence) => {
      const agentId = await createTwoVersionAgent();
      const res = await postEval(agentId, evidence);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an update naming a live rule after an Object property is refused', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, null);
      const res = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ evidence: { live: { window: '7d', toString: 1 } } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('the claim verdict reads production', () => {
    test('a tripwire on a served generation refutes the claim, not the run', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', guardrail_tripwires: { max: 0 } },
      });
      const created = await run({ evalId, version: 2 });
      const [served] = await serve({ agentId, version: 2, count: 1 });
      await tripwire(served!);

      const claim = await claimOf(agentId, 2, evalId);
      expect(claim?.verdict).toBe('refuted');
      expect(
        liveReason(claim!.verdict_reasons, 'guardrail_tripwires')
      ).toMatchObject({ verdict: 'refuted' });

      const runRead = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${created.id}`
      );
      expect(runRead.body.verdict).toBe('supported');
    });

    test("the rules are the run's: clearing the eval's evidence after the run changes nothing", async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', guardrail_tripwires: { max: 0 } },
      });
      await run({ evalId, version: 2 });
      const [served] = await serve({ agentId, version: 2, count: 1 });
      await tripwire(served!);
      const edit = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ evidence: null });
      expect(edit.status).toBe(200);

      const claim = await claimOf(agentId, 2, evalId);
      expect(claim?.verdict).toBe('refuted');
    });

    test('a generation a scorer or judge started for an eval run is not served volume', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', min_served_generations: 2 },
      });
      await run({ evalId, version: 2 });
      await serve({ agentId, version: 2, count: 1 });
      await serve({ agentId, version: 2, count: 3, source: 'eval_scorer' });
      await serve({ agentId, version: 2, count: 3, source: 'eval_judge' });

      const claim = await claimOf(agentId, 2, evalId);
      expect(
        liveReason(claim!.verdict_reasons, 'min_served_generations')
      ).toMatchObject({
        verdict: 'insufficient',
        reason: '1 served, 2 required',
      });
    });

    test('an eval run, another version, a generation before the window and one still in flight are not served volume', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', min_served_generations: 2 },
      });
      await run({ evalId, version: 2 });
      await serve({ agentId, version: 2, count: 1 });
      await serve({ agentId, version: 2, count: 3, source: 'eval' });
      await serve({ agentId, version: 1, count: 3 });
      await serve({
        agentId,
        version: 2,
        count: 3,
        startedAt: new Date(Date.now() - 8 * DAY_MS),
      });
      await serve({ agentId, version: 2, count: 3, status: 'running' });
      await serve({ agentId, version: 2, count: 3, status: 'requires_action' });

      const claim = await claimOf(agentId, 2, evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(
        liveReason(claim!.verdict_reasons, 'min_served_generations')
      ).toMatchObject({ verdict: 'insufficient' });
    });

    test('a tripwire on another version does not count', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', guardrail_tripwires: { max: 0 } },
      });
      await run({ evalId, version: 2 });
      await serve({ agentId, version: 2, count: 1 });
      const [other] = await serve({ agentId, version: 1, count: 1 });
      await tripwire(other!);

      expect((await claimOf(agentId, 2, evalId))?.verdict).toBe('supported');
    });

    test('failed served generations refute a generation_failures rule', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', generation_failures: { max_rate: 0.1 } },
      });
      await run({ evalId, version: 2 });
      await serve({ agentId, version: 2, count: 1 });
      await serve({ agentId, version: 2, count: 1, status: 'failed' });

      const claim = await claimOf(agentId, 2, evalId);
      expect(
        liveReason(claim!.verdict_reasons, 'generation_failures')
      ).toMatchObject({
        verdict: 'refuted',
      });
    });

    test('rejected over decided approvals refute an approval_rejections rule; pending and expired are not decided', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: {
          window: '7d',
          approval_rejections: { max_rate: 0.4, min_decided: 2 },
        },
      });
      await run({ evalId, version: 2 });
      const [first, second, third] = await serve({
        agentId,
        version: 2,
        count: 3,
      });
      await approval(first!, 'rejected');
      await approval(second!, 'approved');
      await approval(third!, 'pending');
      await approval(third!, 'expired');

      const claim = await claimOf(agentId, 2, evalId);
      expect(
        liveReason(claim!.verdict_reasons, 'approval_rejections')
      ).toMatchObject({ verdict: 'refuted' });
    });

    test('a claim whose eval has no threshold has no verdict and no reasons, whatever production says', async () => {
      const agentId = await createTwoVersionAgent();
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          policy_ids: [userPolicyId],
          project_id: projectId,
          name: unique('live-ungated'),
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'contains', name: 'contains', value: 'Paris' }],
          claim: { statement: 'Names capitals.' },
          evidence: { live: { window: '7d', guardrail_tripwires: { max: 0 } } },
        });
      expect(res.status).toBe(201);
      const evalId = res.body.id as string;
      const created = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true, agent_version: 2 });
      expect(created.status).toBe(201);
      const [served] = await serve({ agentId, version: 2, count: 1 });
      await tripwire(served!);

      const claim = await claimOf(agentId, 2, evalId);
      expect(claim).toMatchObject({ verdict: null, verdict_reasons: null });
    });

    test('a live rule recorded on the run that the rules do not read is insufficient, never ignored', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', guardrail_tripwires: { max: 0 } },
      });
      const created = await run({ evalId, version: 2 });
      await serve({ agentId, version: 2, count: 1 });
      const stored = await db.EvalRun.findOne({
        where: { publicId: created.id },
      });
      await stored!.update({
        definition: {
          ...stored!.definition,
          evidence: {
            live: { window: '14d', guardrail_tripwires: { max: 0 } },
          },
        },
      });

      const claim = await claimOf(agentId, 2, evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(liveReason(claim!.verdict_reasons, 'unreadable')).toMatchObject({
        verdict: 'insufficient',
      });
    });

    test('a run created from a live rule the rules do not read records it as written', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', guardrail_tripwires: { max: 0 } },
      });
      const unreadable = { window: '14d', guardrail_tripwires: { max: 0 } };
      await db.Eval.update(
        { evidence: { live: unreadable } },
        { where: { publicId: evalId } }
      );

      // The response contract describes the rules as they are; a value they no
      // longer read is outside it by construction, so the bare app creates it.
      const created = await request(app.callback())
        .post(`/api/v1/evals/${evalId}/runs`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ wait: true, agent_version: 2 });
      expect(created.status).toBe(201);
      expect(created.body.definition.evidence).toEqual({ live: unreadable });
      const stored = await db.EvalRun.findOne({
        where: { publicId: created.body.id },
      });
      expect(stored!.definition?.evidence).toEqual({ live: unreadable });

      const claim = await claimOf(agentId, 2, evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(liveReason(claim!.verdict_reasons, 'unreadable')).toMatchObject({
        verdict: 'insufficient',
      });
    });

    test('a run older than max_run_age_days is insufficient', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, { max_run_age_days: 30 });
      const created = await run({ evalId, version: 2 });
      await db.EvalRun.update(
        { finishedAt: new Date(Date.now() - 31 * DAY_MS) },
        { where: { publicId: created.id } }
      );

      const claim = await claimOf(agentId, 2, evalId);
      expect(claim?.verdict).toBe('insufficient');
      expect(claim!.verdict_reasons).toContainEqual(
        expect.objectContaining({
          scope: { kind: 'age' },
          verdict: 'insufficient',
        })
      );
    });
  });

  describe('promotion reads the claim verdict', () => {
    test('a gate whose canary trips a guardrail blocks promotion', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', guardrail_tripwires: { max: 0 } },
      });
      await run({ evalId, version: 2 });
      const [served] = await serve({ agentId, version: 2, count: 1 });
      await tripwire(served!);
      expect((await release(agentId, { promotion_gate: evalId })).status).toBe(
        200
      );

      const res = await promote(agentId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
      expect(res.body.error.meta.verdict).toBe('refuted');
      expect(
        liveReason(res.body.error.meta.verdict_reasons, 'guardrail_tripwires')
      ).toMatchObject({ verdict: 'refuted' });
    });

    test('a stable claim the canary loses in production blocks promotion', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', guardrail_tripwires: { max: 0 } },
      });
      await run({ evalId, version: 1 });
      await run({ evalId, version: 2 });
      await serve({ agentId, version: 1, count: 1 });
      const [served] = await serve({ agentId, version: 2, count: 1 });
      await tripwire(served!);
      expect((await release(agentId)).status).toBe(200);

      const res = await promote(agentId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_CLAIM_UNMET');
      expect(res.body.error.meta.verdict).toBe('refuted');
    });
  });

  describe('the pawl judges the stable version by its run', () => {
    test('a stable claim with no traffic left in the window is still required', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', min_served_generations: 1 },
      });
      await run({ evalId, version: 1 });
      await serve({
        agentId,
        version: 1,
        count: 1,
        startedAt: new Date(Date.now() - 8 * DAY_MS),
      });
      await run({ evalId, version: 2, reply: 'Lyon' });
      await serve({ agentId, version: 2, count: 1 });
      expect((await release(agentId)).status).toBe(200);

      const res = await promote(agentId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_CLAIM_UNMET');
      expect(res.body.error.meta).toMatchObject({
        eval_id: evalId,
        verdict: 'refuted',
      });
    });

    test('a stable claim whose run outlived max_run_age_days is still required', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, { max_run_age_days: 30 });
      const stableRun = await run({ evalId, version: 1 });
      await db.EvalRun.update(
        { finishedAt: new Date(Date.now() - 31 * DAY_MS) },
        { where: { publicId: stableRun.id } }
      );
      await run({ evalId, version: 2, reply: 'Lyon' });
      expect((await release(agentId)).status).toBe(200);

      const res = await promote(agentId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_CLAIM_UNMET');
    });
  });

  describe('GET /api/v1/agents/:agent_id/versions/:version/promotion-claims', () => {
    test('records the claims a promotion stood on, unmoved by a later run', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, {
        live: { window: '7d', min_served_generations: 1 },
      });
      const canaryRun = await run({ evalId, version: 2 });
      await serve({ agentId, version: 2, count: 1 });
      expect((await release(agentId)).status).toBe(200);
      const promoted = await promote(agentId);
      expect(promoted.status).toBe(200);
      const live = promoted.body.version as number;

      await run({ evalId, version: live });
      const res = await asAdmin().get(
        `/api/v1/agents/${agentId}/versions/${live}/promotion-claims`
      );

      expect(res.status).toBe(200);
      expect(res.body.next_cursor).toBeNull();
      expect(res.body.data).toEqual([
        expect.objectContaining({
          eval_id: evalId,
          eval_run_id: canaryRun.id,
          verdict: 'supported',
          verdict_reasons: expect.arrayContaining([
            expect.objectContaining({
              scope: { kind: 'live', name: 'min_served_generations' },
            }),
          ]),
        }),
      ]);
    });

    test('a version no promotion made live records none', async () => {
      const agentId = await createTwoVersionAgent();
      const res = await asAdmin().get(
        `/api/v1/agents/${agentId}/versions/1/promotion-claims`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('an unauthenticated read is 401', async () => {
      const agentId = await createTwoVersionAgent();
      const res = await testClient.get(
        `/api/v1/agents/${agentId}/versions/1/promotion-claims`
      );
      expect(res.status).toBe(401);
    });

    test('only GetAgentVersion reads the record', async () => {
      const agentId = await createTwoVersionAgent();
      const path = `/api/v1/agents/${agentId}/versions/1/promotion-claims`;
      const reader = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('promotion-claims-reader'),
        actions: ['agents:GetAgentVersion'],
      });
      const other = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('promotion-claims-other'),
        actions: ['agents:GetAgent'],
      });

      expect((await authenticatedTestClient(reader).get(path)).status).toBe(
        200
      );
      const refused = await authenticatedTestClient(other).get(path);
      expect(refused.status).toBe(403);
      expect(refused.body.data).toBeUndefined();
    });

    test('an unknown version is 404 and a version that is not a number is 400', async () => {
      const agentId = await createTwoVersionAgent();
      const unknown = await asAdmin().get(
        `/api/v1/agents/${agentId}/versions/99/promotion-claims`
      );
      expect(unknown.status).toBe(404);
      const malformed = await asAdmin().get(
        `/api/v1/agents/${agentId}/versions/latest/promotion-claims`
      );
      expect(malformed.status).toBe(400);
    });

    test('pages the record by eval_id, and refuses a cursor minted by the live read', async () => {
      const agentId = await createTwoVersionAgent();
      const first = await createEval(agentId, null);
      const second = await createEval(agentId, null);
      await run({ evalId: first, version: 2 });
      await run({ evalId: second, version: 2 });
      expect((await release(agentId)).status).toBe(200);
      const promoted = await promote(agentId);
      expect(promoted.status).toBe(200);
      const live = promoted.body.version as number;
      const base = `/api/v1/agents/${agentId}/versions`;

      const page = await asAdmin().get(
        `${base}/${live}/promotion-claims?limit=1`
      );
      expect(page.status).toBe(200);
      const next = await asAdmin().get(
        `${base}/${live}/promotion-claims?limit=1&cursor=${page.body.next_cursor}`
      );
      expect(
        [...page.body.data, ...next.body.data].map(
          (claim: { eval_id: string }) => {
            return claim.eval_id;
          }
        )
      ).toEqual([first, second].sort());
      expect(next.body.next_cursor).toBeNull();

      const liveRead = await asAdmin().get(`${base}/2/claims?limit=1`);
      expect(liveRead.body.next_cursor).not.toBeNull();
      const crossed = await asAdmin().get(
        `${base}/${live}/promotion-claims?limit=1&cursor=${liveRead.body.next_cursor}`
      );
      expect(crossed.status).toBe(400);
      expect(crossed.body.error.code).toBe('INVALID_CURSOR');
    });

    test('a promotion that archives a new version records the canary claims on it', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createEval(agentId, null);
      const canaryRun = await run({ evalId, version: 2 });
      const draft = await asAdmin()
        .put(`/api/v1/agents/${agentId}`)
        .send({ instructions: 'draft after the canary' });
      expect(draft.status).toBe(200);
      expect((await release(agentId)).status).toBe(200);

      const promoted = await promote(agentId);
      expect(promoted.status).toBe(200);
      expect(promoted.body.version).toBeGreaterThan(3);

      const res = await asAdmin().get(
        `/api/v1/agents/${agentId}/versions/${promoted.body.version}/promotion-claims`
      );
      expect(res.body.data).toEqual([
        expect.objectContaining({ eval_id: evalId, eval_run_id: canaryRun.id }),
      ]);
    });
  });
});
