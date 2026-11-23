import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * An eval-gated promotion (the agents module doc — Eval-gated promotion) is
 * satisfied only by a supported run whose own `agent_id` is the agent being
 * promoted: an Eval is editable, so the agent it names today says nothing
 * about the agent a past run executed. Authentication and permission on
 * `promote` are covered in `agentVersions.test.ts`.
 */
const ITEM_COUNT = 4;

describe('POST /api/v1/agents/{agent_id}/release/promote — the run agent', () => {
  let userToken: string;
  let userPolicyId: string;
  let projectId: string;
  let aiProviderId: string;
  let datasetId: string;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  /** An agent at version 2, so version 2 is a canary over stable 1. */
  const twoVersionAgent = async (name: string): Promise<string> => {
    const created = await asUser()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        instructions: `${name} stable`,
      });
    expect(created.status).toBe(201);
    const updated = await asUser()
      .put(`/api/v1/agents/${created.body.id}`)
      .send({ instructions: `${name} canary` });
    expect(updated.status).toBe(200);
    return created.body.id as string;
  };

  const createGateEval = async (agentId: string): Promise<string> => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({
        policy_ids: [userPolicyId],
        project_id: projectId,
        name: `gate-${agentId}`,
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match', name: 'exact_match' }],
        // Four of four clear 0.5 (interval low ≈ 0.51).
        pass_threshold: 0.5,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const passingRun = async (evalId: string): Promise<string> => {
    for (let index = 0; index < ITEM_COUNT; index += 1) {
      mockCreateGeneration.mockResolvedValueOnce({
        id: `gen_gate_${evalId}_${index}`,
        traceId: `trc_gate_${evalId}_${index}`,
        status: 'completed' as const,
        output: {
          model: 'test-model',
          content: 'Paris',
          finishReason: 'stop' as const,
        },
      });
    }
    const res = await asUser()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({ wait: true, agent_version: 2 });
    expect(res.status).toBe(201);
    expect(res.body.verdict).toBe('supported');
    return res.body.id as string;
  };

  const gate = async (args: { agentId: string; evalId: string }) => {
    const res = await asUser()
      .put(`/api/v1/agents/${args.agentId}/release`)
      .send({
        stable_version: 1,
        canary_version: 2,
        canary_percent: 50,
        promotion_gate: args.evalId,
      });
    expect(res.status).toBe(200);
  };

  const promote = (agentId: string) => {
    return asUser().post(`/api/v1/agents/${agentId}/release/promote`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'gateagent',
      policyActions: [
        'agents:CreateAgent',
        'agents:GetAgent',
        'agents:UpdateAgent',
        'agents:SetAgentRelease',
        'agents:CreateAgentGeneration',
        'evaluations:CreateDataset',
        'evaluations:CreateEval',
        'evaluations:GetEval',
        'evaluations:RunEval',
      ],
    });
    userToken = setup.userToken;
    userPolicyId = setup.policyId;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Gate Agent Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = provider.body.id;

    const dataset = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'gate-agent-dataset' });
    datasetId = dataset.body.id;
    for (let index = 0; index < ITEM_COUNT; index += 1) {
      const item = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({
          input: [{ role: 'user', content: `Capital of France? ${index}` }],
          expected_output: 'Paris',
        });
      expect(item.status).toBe(201);
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('a supported run of the promoted agent satisfies the gate', async () => {
    const agentId = await twoVersionAgent('own');
    const evalId = await createGateEval(agentId);
    await passingRun(evalId);
    await gate({ agentId, evalId });

    const res = await promote(agentId);

    expect(res.status).toBe(200);
    expect(res.body.active_release).toBeNull();
  });

  test('a supported run of another agent at the same version does not satisfy the gate', async () => {
    const otherId = await twoVersionAgent('other');
    const evalId = await createGateEval(otherId);
    await passingRun(evalId);

    const agentId = await twoVersionAgent('repointed');
    const repoint = await asUser()
      .put(`/api/v1/evals/${evalId}`)
      .send({ agent_id: agentId });
    expect(repoint.status).toBe(200);
    await gate({ agentId, evalId });

    const res = await promote(agentId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
  });

  test('a supported run that recorded no agent does not satisfy the gate', async () => {
    const agentId = await twoVersionAgent('unrecorded');
    const evalId = await createGateEval(agentId);
    const runId = await passingRun(evalId);
    await db.EvalRun.update(
      { agentPublicId: null },
      { where: { publicId: runId } }
    );
    await gate({ agentId, evalId });

    const res = await promote(agentId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROMOTION_GATE_UNMET');
  });
});
