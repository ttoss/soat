import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Whoever creates or edits a resource that acts later holds what it will do:
 * the policies it carries, the targets it starts, the secrets it sends. An
 * edit is checked against the resource as it stands after the write.
 */
describe('Writer rule', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let providerId: string;
  let orchestrationId: string;
  let otherOrchestrationId: string;
  let heldPolicyId: string;
  let widerPolicyId: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };
  const user = () => {
    return authenticatedTestClient(userToken);
  };

  const createPolicy = async (action: string[]): Promise<string> => {
    const res = await admin()
      .post('/api/v1/policies')
      .send({ document: { statement: [{ effect: 'Allow', action }] } });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createOrchestration = async (name: string): Promise<string> => {
    const res = await admin()
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name,
        nodes: [
          {
            id: 'start',
            type: 'transform',
            expression: { var: '' },
            state_mapping: { 'state.result': { var: 'output.output' } },
          },
        ],
        edges: [],
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (body: Record<string, unknown>) => {
    const res = await admin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerId,
        name: 'wr-agent',
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'writerrule',
      createOtherProject: true,
      policyActions: [
        'triggers:CreateTrigger',
        'triggers:GetTrigger',
        'triggers:UpdateTrigger',
        'webhooks:CreateWebhook',
        'webhooks:UpdateWebhook',
        'agents:GetAgent',
        'agents:UpdateAgent',
        'agents:RestoreAgentVersion',
        'orchestrations:CreateOrchestration',
        'orchestrations:UpdateOrchestration',
        'orchestrations:StartRun',
        'shares:CreateShare',
        'tools:GetTool',
        'formations:CreateFormation',
        'formations:GetFormation',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    providerId = (
      await admin().post('/api/v1/ai-providers').send({
        project_id: projectId,
        name: 'wr-provider',
        provider: 'ollama',
        default_model: 'stub-model',
      })
    ).body.id;
    orchestrationId = await createOrchestration('wr-orch');
    otherOrchestrationId = await createOrchestration('wr-orch-other');
    heldPolicyId = await createPolicy(['orchestrations:StartRun']);
    widerPolicyId = await createPolicy(['agents:DeleteAgent']);
  });

  describe('PATCH /api/v1/triggers/:trigger_id', () => {
    let triggerId: string;

    beforeAll(async () => {
      const res = await admin()
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'wr-trigger',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          policy_ids: [widerPolicyId],
        });
      expect(res.status).toBe(201);
      triggerId = res.body.id;
    });

    test('refuses retargeting a trigger whose policies the writer does not hold', async () => {
      const res = await user()
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ target_id: otherOrchestrationId });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
      const read = await admin().get(`/api/v1/triggers/${triggerId}`);
      expect(read.body.target_id).toBe(orchestrationId);
    });

    test('lets the writer replace them with policies it holds', async () => {
      const created = await admin()
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'wr-trigger-replace',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          policy_ids: [widerPolicyId],
        });
      const res = await user()
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ policy_ids: [heldPolicyId], target_id: otherOrchestrationId });

      expect(res.status).toBe(200);
      expect(res.body.policy_ids).toEqual([heldPolicyId]);
    });
  });

  describe('POST /api/v1/formations trigger resource', () => {
    test('refuses a trigger whose target the deployer may not start', async () => {
      const agentId = await createAgent({ name: 'wr-formation-target' });
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'wr-formation',
          template: {
            resources: {
              Trigger: {
                type: 'trigger',
                properties: {
                  name: 'wr-formation-trigger',
                  type: 'manual',
                  target_type: 'agent',
                  target_id: agentId,
                  policy_ids: [heldPolicyId],
                },
              },
            },
          },
        });

      expect(res.body.status).not.toBe('active');
      expect(JSON.stringify(res.body)).toContain('ACTION_NOT_HELD');
    });
  });

  describe('PUT /api/v1/webhooks/:webhook_id', () => {
    test('refuses repointing a webhook whose policies the writer does not hold', async () => {
      const created = await admin()
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [widerPolicyId],
          name: 'wr-webhook',
          url: 'https://example.com/hook',
          events: ['file.created'],
        });
      expect(created.status).toBe(201);

      const res = await user()
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ url: 'https://attacker.example.com/hook' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });
  });

  describe('POST /api/v1/agents/:agent_id/versions/:version/restore', () => {
    test('refuses restoring a version whose policies the writer does not hold', async () => {
      const agentId = await createAgent({
        name: 'wr-restore',
        policy_ids: [widerPolicyId],
      });
      const narrowed = await admin()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ policy_ids: [heldPolicyId] });
      expect(narrowed.status).toBe(200);

      const res = await user()
        .post(`/api/v1/agents/${agentId}/versions/1/restore`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
      const read = await admin().get(`/api/v1/agents/${agentId}`);
      expect(read.body.policy_ids).toEqual([heldPolicyId]);
    });

    test('restores a version whose policies the writer holds', async () => {
      const agentId = await createAgent({
        name: 'wr-restore-held',
        policy_ids: [heldPolicyId],
      });
      await admin()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: 'Changed.' });

      const res = await user()
        .post(`/api/v1/agents/${agentId}/versions/1/restore`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.policy_ids).toEqual([heldPolicyId]);
    });
  });

  describe('POST /api/v1/orchestrations', () => {
    const agentNodeBody = (agentId: string) => {
      return {
        project_id: projectId,
        name: 'wr-agent-orch',
        nodes: [{ id: 'ask', type: 'agent', agent_id: agentId }],
        edges: [],
      };
    };

    test('refuses an agent node the writer may not run', async () => {
      const agentId = await createAgent({ name: 'wr-orch-agent' });
      const res = await user()
        .post('/api/v1/orchestrations')
        .send(agentNodeBody(agentId));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACTION_NOT_HELD');
      expect(res.body.error.meta).toEqual({
        action: 'agents:CreateAgentGeneration',
        resource: `srn:${projectId}:agent:${agentId}`,
      });
    });

    test('an admin names any agent', async () => {
      const agentId = await createAgent({ name: 'wr-orch-agent-admin' });
      const res = await admin()
        .post('/api/v1/orchestrations')
        .send(agentNodeBody(agentId));

      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/v1/shares', () => {
    test('refuses sharing a tool the creator may not call', async () => {
      const tool = await admin()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'wr-tool',
          type: 'client',
          description: 'A tool',
          parameters: { type: 'object', properties: {} },
        });
      expect(tool.status).toBe(201);

      const res = await user()
        .post('/api/v1/shares')
        .send({
          project_id: projectId,
          resource: `srn:${projectId}:tool:${tool.body.id}`,
          actions: ['tools:CallTool'],
          grantee: otherProjectId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACTION_NOT_HELD');
    });
  });
});
