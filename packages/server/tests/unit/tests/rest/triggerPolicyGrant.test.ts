import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A policy attached to a trigger is what its firings may do, so attaching one,
 * or editing one already attached, needs a writer who holds every grant in it.
 */
describe('Trigger policy grant check', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let orchestrationId: string;
  let heldPolicyId: string;
  let widerPolicyId: string;

  const createPolicy = async (action: string[]): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement: [{ effect: 'Allow', action }] } });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createTrigger = (args: {
    token: string;
    name: string;
    policyId?: string;
  }) => {
    return authenticatedTestClient(args.token)
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: args.name,
        type: 'manual',
        target_type: 'orchestration',
        target_id: orchestrationId,
        policy_ids: [args.policyId ?? heldPolicyId],
      });
  };

  const deployTrigger = (args: { name: string; policyId: string }) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: args.name,
        template: {
          resources: {
            Trigger: {
              type: 'trigger',
              properties: {
                name: args.name,
                type: 'manual',
                target_type: 'orchestration',
                target_id: orchestrationId,
                policy_ids: [args.policyId],
              },
            },
          },
        },
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'trgrant',
      policyActions: [
        'triggers:CreateTrigger',
        'triggers:GetTrigger',
        'triggers:UpdateTrigger',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'formations:CreateFormation',
        'formations:GetFormation',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    orchestrationId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'trgrant-orchestration',
          nodes: [
            {
              id: 'start',
              type: 'transform',
              expression: { var: '' },
              state_mapping: { 'state.result': { var: 'output.output' } },
            },
          ],
          edges: [],
        })
    ).body.id;

    heldPolicyId = await createPolicy(['orchestrations:StartRun']);
    widerPolicyId = await createPolicy(['agents:DeleteAgent']);
  });

  describe('POST /api/v1/triggers', () => {
    test('attaches a policy the writer holds', async () => {
      const res = await createTrigger({
        token: userToken,
        name: 'trgrant-held',
        policyId: heldPolicyId,
      });

      expect(res.status).toBe(201);
      expect(res.body.policy_ids).toEqual([heldPolicyId]);
    });

    test('refuses a policy granting what the writer lacks with 403', async () => {
      const res = await createTrigger({
        token: userToken,
        name: 'trgrant-wider',
        policyId: widerPolicyId,
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
      const res = await createTrigger({
        token: adminToken,
        name: 'trgrant-admin',
        policyId: widerPolicyId,
      });

      expect(res.status).toBe(201);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/triggers').send({
        project_id: projectId,
        name: 'trgrant-anon',
        type: 'manual',
        target_type: 'orchestration',
        target_id: orchestrationId,
        policy_ids: [heldPolicyId],
      });

      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/triggers/:trigger_id', () => {
    let triggerId: string;

    beforeAll(async () => {
      triggerId = (await createTrigger({ token: userToken, name: 'trgrant-p' }))
        .body.id;
    });

    test('attaches a policy the writer holds', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ policy_ids: [heldPolicyId] });

      expect(res.status).toBe(200);
      expect(res.body.policy_ids).toEqual([heldPolicyId]);
    });

    test('refuses a policy granting what the writer lacks with 403', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ policy_ids: [widerPolicyId] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers/${triggerId}`
      );
      expect(read.body.policy_ids).not.toContain(widerPolicyId);
    });
  });

  describe('PUT /api/v1/policies/:policy_id', () => {
    test('an admin edits a policy a trigger carries', async () => {
      const policyId = await createPolicy(['orchestrations:StartRun']);
      const created = await createTrigger({
        token: userToken,
        name: 'trgrant-edit',
        policyId,
      });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(adminToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['agents:DeleteAgent'] }],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.document.statement[0].action).toEqual([
        'agents:DeleteAgent',
      ]);
    });
  });

  describe('formation trigger resource', () => {
    test('deploys a trigger with a policy the deployer holds', async () => {
      const res = await deployTrigger({
        name: 'trgrant-fheld',
        policyId: heldPolicyId,
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });

    test('deploys a trigger naming a policy declared in the same template', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'trgrant-fref',
          template: {
            resources: {
              Runner: {
                type: 'policy',
                properties: {
                  document: {
                    statement: [
                      { effect: 'Allow', action: ['orchestrations:StartRun'] },
                    ],
                  },
                },
              },
              Trigger: {
                type: 'trigger',
                properties: {
                  name: 'trgrant-fref',
                  type: 'manual',
                  target_type: 'orchestration',
                  target_id: orchestrationId,
                  policy_ids: [{ ref: 'Runner' }],
                },
              },
            },
            outputs: {
              trigger_id: { ref: 'Trigger' },
              policy_id: { ref: 'Runner' },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      const trigger = await authenticatedTestClient(adminToken).get(
        `/api/v1/triggers/${res.body.outputs.trigger_id}`
      );
      expect(trigger.body.policy_ids).toEqual([res.body.outputs.policy_id]);
    });

    test('fails a trigger with a policy granting what the deployer lacks', async () => {
      const res = await deployTrigger({
        name: 'trgrant-fwider',
        policyId: widerPolicyId,
      });

      expect(res.body.status).not.toBe('active');
      expect(JSON.stringify(res.body)).toContain('POLICY_GRANT_NOT_HELD');
    });
  });
});
