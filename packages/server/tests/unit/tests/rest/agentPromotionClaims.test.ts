import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * The claims a version holds, and the pawl on promotion (the agents module
 * doc — Eval-gated promotion): every claim the stable version's run supports
 * must be supported by the canary too, or named in the release's
 * `released_claims`.
 */

type Message = { role: string; content: string };

describe('Agent version claims', () => {
  let adminToken: string;
  let userToken: string;
  let userPolicyId: string;
  let projectId: string;
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
        name: unique('claims-agent'),
        instructions: 'stable prompt',
      });
    expect(agent.status).toBe(201);
    const edit = await asAdmin()
      .put(`/api/v1/agents/${agent.body.id}`)
      .send({ instructions: 'canary prompt' });
    expect(edit.status).toBe(200);
    return agent.body.id as string;
  };

  /** 4 of 4 passing clears 0.5; 0 of 4 is refuted. */
  const createClaimEval = async (
    agentId: string,
    claim: Record<string, unknown> | null = { statement: 'Names capitals.' }
  ): Promise<string> => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: unique('claims-eval'),
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', name: 'contains', value: 'Paris' }],
        pass_threshold: 0.5,
        claim,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const run = async (args: {
    evalId: string;
    version: number;
    reply: string;
  }) => {
    answer = args.reply;
    const res = await asUser()
      .post(`/api/v1/evals/${args.evalId}/runs`)
      .send({ wait: true, agent_version: args.version });
    expect(res.status).toBe(201);
    return res.body as { id: string; verdict: string };
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

  const claimsOf = (agentId: string, version: number) => {
    return asAdmin().get(
      `/api/v1/agents/${agentId}/versions/${version}/claims`
    );
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
      prefix: 'versionclaims',
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

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Claims Provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
    providerId = provider.body.id;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'version-claims-dataset' });
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

  describe('GET /api/v1/agents/:agent_id/versions/:version/claims', () => {
    test('lists the claim of each eval whose newest run carries one', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      const unclaimed = await createClaimEval(agentId, null);
      const older = await run({ evalId, version: 1, reply: 'Paris' });
      const newer = await run({ evalId, version: 1, reply: 'Lyon' });
      await run({ evalId: unclaimed, version: 1, reply: 'Paris' });

      const res = await claimsOf(agentId, 1);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        {
          eval_id: evalId,
          eval_run_id: newer.id,
          claim: {
            statement: 'Names capitals.',
            population: null,
            limits: null,
          },
          verdict: 'refuted',
          verdict_reasons: [
            expect.objectContaining({ scope: { kind: 'run' } }),
          ],
          settled_at: expect.any(String),
        },
      ]);
      expect(older.verdict).toBe('supported');
    });

    test('lists one claim per eval, ordered by eval_id', async () => {
      const agentId = await createTwoVersionAgent();
      const first = await createClaimEval(agentId);
      const second = await createClaimEval(agentId);
      await run({ evalId: first, version: 1, reply: 'Paris' });
      await run({ evalId: second, version: 1, reply: 'Paris' });

      const res = await claimsOf(agentId, 1);

      expect(res.status).toBe(200);
      expect(
        (res.body.data as Array<{ eval_id: string }>).map((claim) => {
          return claim.eval_id;
        })
      ).toEqual([first, second].sort());
    });

    test('a version with no run holds no claim', async () => {
      const agentId = await createTwoVersionAgent();
      await createClaimEval(agentId);

      const res = await claimsOf(agentId, 2);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('an unknown agent is 404', async () => {
      const res = await claimsOf('agent_doesnotexist0000', 1);
      expect(res.status).toBe(404);
    });

    test('an unknown version is 404', async () => {
      const agentId = await createTwoVersionAgent();
      const res = await claimsOf(agentId, 99);
      expect(res.status).toBe(404);
    });

    test('an unauthenticated read is 401', async () => {
      const agentId = await createTwoVersionAgent();
      const res = await testClient.get(
        `/api/v1/agents/${agentId}/versions/1/claims`
      );
      expect(res.status).toBe(401);
    });

    test('only GetAgentVersion reads the claims', async () => {
      const agentId = await createTwoVersionAgent();
      const path = `/api/v1/agents/${agentId}/versions/1/claims`;
      const reader = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('claims-reader'),
        actions: ['agents:GetAgentVersion'],
      });
      const other = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('claims-other'),
        actions: ['agents:GetAgent'],
      });

      expect((await authenticatedTestClient(reader).get(path)).status).toBe(
        200
      );
      // GetAgent shows the agent the claims hang off, so a 404 would contradict it.
      const refused = await authenticatedTestClient(other).get(path);
      expect(refused.status).toBe(403);
      expect(refused.body.data).toBeUndefined();
    });
  });

  describe("promotion keeps every claim the stable version's run supports", () => {
    test('a canary supporting every stable claim promotes', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      await run({ evalId, version: 1, reply: 'Paris' });
      await run({ evalId, version: 2, reply: 'Paris' });
      expect((await release(agentId)).status).toBe(200);

      const res = await promote(agentId);
      expect(res.status).toBe(200);

      const live = await asAdmin().get(
        `/api/v1/agents/${agentId}/versions/${res.body.version}`
      );
      expect(live.status).toBe(200);
      expect(live.body.released_claims).toEqual([]);
    });

    test('a canary refuting a stable claim is refused naming it', async () => {
      const agentId = await createTwoVersionAgent();
      const kept = await createClaimEval(agentId);
      const lost = await createClaimEval(agentId, {
        statement: 'Never names Lyon.',
      });
      await run({ evalId: kept, version: 1, reply: 'Paris' });
      await run({ evalId: lost, version: 1, reply: 'Paris' });
      await run({ evalId: kept, version: 2, reply: 'Paris' });
      const canaryRun = await run({ evalId: lost, version: 2, reply: 'Lyon' });
      expect((await release(agentId)).status).toBe(200);

      const res = await promote(agentId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_CLAIM_UNMET');
      expect(res.body.error.meta).toMatchObject({
        eval_id: lost,
        claim: { statement: 'Never names Lyon.' },
        canary_version: 2,
        eval_run_id: canaryRun.id,
        verdict: 'refuted',
        verdict_reasons: [expect.objectContaining({ scope: { kind: 'run' } })],
      });
      const agent = await asAdmin().get(`/api/v1/agents/${agentId}`);
      expect(agent.body.active_release).not.toBeNull();
    });

    test('a canary with no run of a stable claim is refused', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      await run({ evalId, version: 1, reply: 'Paris' });
      expect((await release(agentId)).status).toBe(200);

      const res = await promote(agentId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_CLAIM_UNMET');
      expect(res.body.error.meta).toMatchObject({
        eval_id: evalId,
        eval_run_id: null,
        verdict: null,
      });
    });

    test('a canary run that carries no claim holds none, so it is refused', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      await run({ evalId, version: 1, reply: 'Paris' });
      const cleared = await asUser()
        .put(`/api/v1/evals/${evalId}`)
        .send({ claim: null });
      expect(cleared.status).toBe(200);
      const canaryRun = await run({ evalId, version: 2, reply: 'Paris' });
      expect(canaryRun.verdict).toBe('supported');
      expect((await release(agentId)).status).toBe(200);

      const res = await promote(agentId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_CLAIM_UNMET');
      expect(res.body.error.meta).toMatchObject({
        eval_id: evalId,
        claim: { statement: 'Names capitals.' },
        eval_run_id: null,
        verdict: null,
      });
    });

    test('a claim the stable version does not support is not required', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      await run({ evalId, version: 1, reply: 'Lyon' });
      expect((await release(agentId)).status).toBe(200);

      expect((await promote(agentId)).status).toBe(200);
    });

    test('a released claim promotes and is recorded on the live version', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      await run({ evalId, version: 1, reply: 'Paris' });
      await run({ evalId, version: 2, reply: 'Lyon' });
      const set = await release(agentId, { released_claims: [evalId] });
      expect(set.status).toBe(200);
      expect(set.body.active_release.released_claims).toEqual([evalId]);

      const res = await promote(agentId);
      expect(res.status).toBe(200);

      const live = await asAdmin().get(
        `/api/v1/agents/${agentId}/versions/${res.body.version}`
      );
      expect(live.body.released_claims).toEqual([evalId]);
    });

    test('re-setting the release without released_claims requires the claim again', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      await run({ evalId, version: 1, reply: 'Paris' });
      expect(
        (await release(agentId, { released_claims: [evalId] })).status
      ).toBe(200);
      const reset = await release(agentId);
      expect(reset.body.active_release.released_claims).toEqual([]);

      expect((await promote(agentId)).status).toBe(409);
    });

    test('a gate whose eval was deleted mid-rollout blocks promotion', async () => {
      const agentId = await createTwoVersionAgent();
      const gateEval = await createClaimEval(agentId);
      await run({ evalId: gateEval, version: 2, reply: 'Paris' });
      expect(
        (await release(agentId, { promotion_gate: gateEval })).status
      ).toBe(200);
      expect((await asAdmin().delete(`/api/v1/evals/${gateEval}`)).status).toBe(
        204
      );

      const res = await promote(agentId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
    });

    test('the gate is checked before the claims', async () => {
      const agentId = await createTwoVersionAgent();
      const gateEval = await createClaimEval(agentId);
      const other = await createClaimEval(agentId);
      await run({ evalId: other, version: 1, reply: 'Paris' });
      expect(
        (await release(agentId, { promotion_gate: gateEval })).status
      ).toBe(200);

      const res = await promote(agentId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
    });

    test('abort is never blocked by a claim', async () => {
      const agentId = await createTwoVersionAgent();
      const evalId = await createClaimEval(agentId);
      await run({ evalId, version: 1, reply: 'Paris' });
      expect((await release(agentId)).status).toBe(200);

      const res = await asAdmin().post(
        `/api/v1/agents/${agentId}/release/abort`
      );
      expect(res.status).toBe(200);
    });

    test.each([
      ['a non-array', 'eval_x'],
      ['an empty id', ['']],
      ['a repeated id', ['same', 'same']],
      ['an eval outside the project', ['eval_doesnotexist']],
    ])('released_claims with %s is 400', async (_label, releasedClaims) => {
      const agentId = await createTwoVersionAgent();
      const res = await release(agentId, { released_claims: releasedClaims });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
