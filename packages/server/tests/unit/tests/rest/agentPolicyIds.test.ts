import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * An agent's `policy_ids` cap every generation it runs, so attaching one, or
 * editing one already attached, needs a writer who holds every grant in it.
 */
describe('Agent policy_ids', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let heldPolicyId: string;
  let widerPolicyId: string;
  let providerId: string;

  const createPolicy = async (action: string[]): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement: [{ effect: 'Allow', action }] } });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = (args: {
    token: string;
    body?: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(args.token)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerId,
        name: 'apol-agent',
        ...args.body,
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'agentpol',
      policyActions: [
        'agents:CreateAgent',
        'agents:GetAgent',
        'agents:UpdateAgent',
        'files:GetFile',
        'formations:CreateFormation',
        'formations:GetFormation',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    providerId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'apol-provider',
          provider: 'ollama',
          default_model: 'stub-model',
        })
    ).body.id;
    heldPolicyId = await createPolicy(['files:GetFile']);
    widerPolicyId = await createPolicy(['agents:DeleteAgent']);
  });

  describe('POST /api/v1/agents', () => {
    test('attaches a policy the writer holds', async () => {
      const res = await createAgent({
        token: userToken,
        body: { policy_ids: [heldPolicyId] },
      });

      expect(res.status).toBe(201);
      expect(res.body.policy_ids).toEqual([heldPolicyId]);
      expect(res.body.boundary_policy).toBeUndefined();
    });

    test('refuses a policy granting what the writer lacks with 403', async () => {
      const res = await createAgent({
        token: userToken,
        body: { policy_ids: [heldPolicyId, widerPolicyId] },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
      expect(res.body.error.meta.ungranted).toEqual([
        {
          policy_id: widerPolicyId,
          statement: 0,
          action: 'agents:DeleteAgent',
          resource: `srn:${projectId}:*:*`,
        },
      ]);
    });

    test('an admin attaches any policy', async () => {
      const res = await createAgent({
        token: adminToken,
        body: { policy_ids: [widerPolicyId] },
      });

      expect(res.status).toBe(201);
    });

    test('an unknown policy is 400 POLICY_NOT_FOUND', async () => {
      const res = await createAgent({
        token: adminToken,
        body: { policy_ids: ['pol_doesnotexist'] },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_NOT_FOUND');
    });

    test('an inline boundary_policy is an unknown field', async () => {
      const res = await createAgent({
        token: adminToken,
        body: {
          boundary_policy: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .post('/api/v1/agents')
        .send({ project_id: projectId, policy_ids: [heldPolicyId] });

      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/agents/:agent_id', () => {
    test('refuses adding a policy granting what the writer lacks', async () => {
      const agentId = (await createAgent({ token: userToken })).body.id;

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ policy_ids: [widerPolicyId] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(read.body.policy_ids).toBeNull();
    });

    test('keeping a policy attached by someone else needs no grant', async () => {
      const agentId = (
        await createAgent({
          token: adminToken,
          body: { policy_ids: [widerPolicyId] },
        })
      ).body.id;

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ name: 'renamed', policy_ids: [widerPolicyId, heldPolicyId] });

      expect(res.status).toBe(200);
      expect(res.body.policy_ids).toEqual([widerPolicyId, heldPolicyId]);
    });

    test('null detaches every policy', async () => {
      const agentId = (
        await createAgent({
          token: userToken,
          body: { policy_ids: [heldPolicyId] },
        })
      ).body.id;

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ policy_ids: null });

      expect(res.status).toBe(200);
      expect(res.body.policy_ids).toBeNull();
    });
  });

  describe('PUT /api/v1/policies/:policy_id', () => {
    test('an admin widens a policy an agent carries', async () => {
      const policyId = await createPolicy(['files:GetFile']);
      await createAgent({
        token: adminToken,
        body: { policy_ids: [policyId] },
      });

      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['agents:DeleteAgent'] }],
          },
        });

      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /api/v1/policies/:policy_id', () => {
    test('a policy an agent carries cannot be deleted', async () => {
      const policyId = await createPolicy(['files:GetFile']);
      const agentId = (
        await createAgent({
          token: adminToken,
          body: { policy_ids: [policyId] },
        })
      ).body.id;

      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/policies/${policyId}`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('POLICY_HAS_DEPENDENTS');
      expect(res.body.error.meta).toEqual(
        expect.objectContaining({ agents: 1, agent_sample: [agentId] })
      );
    });
  });

  describe('formation agent resource', () => {
    const deployAgent = (args: { name: string; policyId: string }) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: args.name,
          template: {
            resources: {
              Agent: {
                type: 'agent',
                properties: {
                  name: args.name,
                  ai_provider_id: providerId,
                  policy_ids: [args.policyId],
                },
              },
            },
          },
        });
    };

    test('deploys an agent with a policy the deployer holds', async () => {
      const res = await deployAgent({
        name: 'apol-fheld',
        policyId: heldPolicyId,
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });

    test('fails an agent with a policy granting what the deployer lacks', async () => {
      const res = await deployAgent({
        name: 'apol-fwider',
        policyId: widerPolicyId,
      });

      expect(res.body.status).not.toBe('active');
      expect(JSON.stringify(res.body)).toContain('POLICY_GRANT_NOT_HELD');
    });
  });
});
