import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * What a promotion gate accepts as evidence (the agents module doc —
 * Eval-gated promotion): the newest completed run of the gate's eval, pinned
 * to the canary version **of this agent**, and only when its verdict is
 * `supported`.
 */

type Message = { role: string; content: string };

describe('Promotion gate — the evidence it reads', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let providerId: string;
  let datasetId: string;
  let answer = 'Paris';
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  /** An agent with two versions, so version 2 exists on every agent. */
  const createTwoVersionAgent = async (): Promise<string> => {
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerId,
        name: unique('gate-agent'),
        instructions: 'stable prompt',
      });
    expect(agent.status).toBe(201);
    const edit = await authenticatedTestClient(adminToken)
      .put(`/api/v1/agents/${agent.body.id}`)
      .send({ instructions: 'canary prompt' });
    expect(edit.status).toBe(200);
    return agent.body.id as string;
  };

  /** 4 of 4 passing clears 0.5 (low ≈ 0.51); 1 of 4 is under it. */
  const createGateEval = async (targetAgentId: string): Promise<string> => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: unique('gate-eval'),
        agent_id: targetAgentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'Paris' }],
        pass_threshold: 0.5,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** The same four items held to 0.9: 4 of 4 is short of it (low ≈ 0.51). */
  const createEval4Items90 = async (targetAgentId: string) => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: unique('gate-eval-strict'),
        agent_id: targetAgentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'Paris' }],
        pass_threshold: 0.9,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const runAgainst = async (args: {
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

  const gate = async (agentId: string, evalId: string) => {
    const res = await authenticatedTestClient(adminToken)
      .put(`/api/v1/agents/${agentId}/release`)
      .send({
        stable_version: 1,
        canary_version: 2,
        canary_percent: 50,
        promotion_gate: evalId,
      });
    expect(res.status).toBe(200);
  };

  const promote = (agentId: string) => {
    return authenticatedTestClient(adminToken).post(
      `/api/v1/agents/${agentId}/release/promote`
    );
  };

  beforeAll(async () => {
    mockCreateGeneration.mockImplementation(async (args) => {
      const content = (args.messages as Message[])[0]!.content;
      return {
        id: `gen_${content}`,
        traceId: `trc_${content}`,
        status: 'completed' as const,
        output: { model: 'test-model', content: answer, finishReason: 'stop' },
      };
    });

    const setup = await setupProjectWithUsers({
      prefix: 'gateevidence',
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
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Gate Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    providerId = provider.body.id;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'gate-evidence-dataset' });
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

  test('a supported run against the canary promotes', async () => {
    const agentId = await createTwoVersionAgent();
    const evalId = await createGateEval(agentId);
    await gate(agentId, evalId);

    const run = await runAgainst({ evalId, version: 2, reply: 'Paris' });
    expect(run.verdict).toBe('supported');

    const res = await promote(agentId);
    expect(res.status).toBe(200);
    expect(res.body.active_release).toBeNull();
  });

  test('a run of another agent with the same version number does not open the gate', async () => {
    const promotedId = await createTwoVersionAgent();
    const otherId = await createTwoVersionAgent();

    // The eval measured the other agent's version 2 and passed...
    const evalId = await createGateEval(otherId);
    const run = await runAgainst({ evalId, version: 2, reply: 'Paris' });
    expect(run.verdict).toBe('supported');

    // ...then it is pointed at the agent being promoted, which also has a
    // version 2. The run still describes the other agent.
    const repoint = await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ agent_id: promotedId });
    expect(repoint.status).toBe(200);
    await gate(promotedId, evalId);

    const res = await promote(promotedId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
  });

  test('an insufficient run blocks and names its verdict and reasons', async () => {
    const agentId = await createTwoVersionAgent();
    const evalId = await createEval4Items90(agentId);
    await gate(agentId, evalId);

    const run = await runAgainst({ evalId, version: 2, reply: 'Paris' });
    expect(run.verdict).toBe('insufficient');

    const res = await promote(agentId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
    expect(res.body.error.meta).toMatchObject({
      promotion_gate: evalId,
      agent_version: 2,
      eval_run_id: run.id,
      verdict: 'insufficient',
      verdict_reasons: [expect.objectContaining({ scope: { kind: 'run' } })],
    });
  });

  test('a newer refuted run revokes an older supported one', async () => {
    const agentId = await createTwoVersionAgent();
    const evalId = await createGateEval(agentId);
    await gate(agentId, evalId);

    expect(
      (await runAgainst({ evalId, version: 2, reply: 'Paris' })).verdict
    ).toBe('supported');
    const newer = await runAgainst({ evalId, version: 2, reply: 'Lyon' });
    expect(newer.verdict).toBe('refuted');

    const res = await promote(agentId);
    expect(res.status).toBe(409);
    expect(res.body.error.meta).toMatchObject({
      eval_run_id: newer.id,
      verdict: 'refuted',
    });
  });

  test('a newer run against another version does not revoke the canary run', async () => {
    const agentId = await createTwoVersionAgent();
    const evalId = await createGateEval(agentId);
    await gate(agentId, evalId);

    await runAgainst({ evalId, version: 2, reply: 'Paris' });
    await runAgainst({ evalId, version: 1, reply: 'Lyon' });

    expect((await promote(agentId)).status).toBe(200);
  });
});
