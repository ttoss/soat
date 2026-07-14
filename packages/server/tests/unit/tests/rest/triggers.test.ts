import crypto from 'node:crypto';

import { signTriggerToken } from 'src/lib/triggerToken';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Triggers', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let limitedToken: string; // has triggers:CreateTrigger but no target-start action
  let projectId: string;
  let otherProjectId: string;

  let orchestrationId: string;
  let agentId: string;
  let httpToolId: string;
  let mcpToolId: string;
  let clientToolId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'triggers',
      policyActions: [
        'triggers:ListTriggers',
        'triggers:CreateTrigger',
        'triggers:GetTrigger',
        'triggers:UpdateTrigger',
        'triggers:DeleteTrigger',
        'triggers:FireTrigger',
        'triggers:GetTriggerSecret',
        'triggers:RotateTriggerSecret',
        'triggers:ListTriggerFirings',
        'triggers:GetTriggerFiring',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'tools:CreateTool',
        'tools:CallTool',
        'ai-providers:CreateAiProvider',
      ],
      createOtherProject: true,
      createNoPermUser: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    // A user that can create triggers but cannot start any target — used to
    // prove the no-privilege-escalation guard.
    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'triggerslimited', password: 'limitedpass' });
    const limitedUserId = (
      await authenticatedTestClient(adminToken).get('/api/v1/users')
    ).body.find((u: { username: string; id: string }) => {
      return u.username === 'triggerslimited';
    }).id;
    const limitedPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        name: 'triggers-limited',
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['triggers:CreateTrigger', 'triggers:GetTrigger'],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${limitedUserId}/policies`)
      .send({ policy_ids: [limitedPolicy.body.id] });
    limitedToken = await loginAs('triggerslimited', 'limitedpass');

    // Targets in the project.
    const aiProv = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Triggers Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    agentId = (
      await authenticatedTestClient(adminToken).post('/api/v1/agents').send({
        project_id: projectId,
        name: 'Triggers Test Agent',
        ai_provider_id: aiProv.body.id,
      })
    ).body.id;

    orchestrationId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'Triggers Test Orchestration',
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

    httpToolId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'triggers-http-tool' })
    ).body.id;

    mcpToolId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'triggers-mcp-tool', type: 'mcp' })
    ).body.id;

    clientToolId = (
      await authenticatedTestClient(adminToken).post('/api/v1/tools').send({
        project_id: projectId,
        name: 'triggers-client-tool',
        type: 'client',
      })
    ).body.id;
  });

  describe('POST /api/v1/triggers', () => {
    test('creates a manual orchestration trigger', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'manual-orch',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          input: { foo: 'bar' },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^trg_/);
      expect(res.body.name).toBe('manual-orch');
      expect(res.body.type).toBe('manual');
      expect(res.body.target_type).toBe('orchestration');
      expect(res.body.target_id).toBe(orchestrationId);
      expect(res.body.active).toBe(true);
      expect(res.body.project_id).toBe(projectId);
      // manual triggers have no secret
      expect(res.body.secret).toBeUndefined();
    });

    test('creates a webhook trigger and returns its secret on create', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'webhook-agent',
          type: 'webhook',
          target_type: 'agent',
          target_id: agentId,
        });

      expect(res.status).toBe(201);
      expect(res.body.type).toBe('webhook');
      expect(typeof res.body.secret).toBe('string');
      expect(res.body.secret.length).toBeGreaterThan(0);
    });

    test('creates a schedule trigger and computes next_fire_at', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'schedule-tool',
          type: 'schedule',
          target_type: 'tool',
          target_id: httpToolId,
          cron: '0 8 * * *',
        });

      expect(res.status).toBe(201);
      expect(res.body.cron).toBe('0 8 * * *');
      expect(res.body.next_fire_at).toBeTruthy();
      expect(res.body.secret).toBeUndefined();
    });

    test('rejects a schedule trigger without cron (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'schedule-nocron',
          type: 'schedule',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_ACTION_NOT_ALLOWED');
    });

    test('rejects cron on a non-schedule trigger (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'manual-with-cron',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          cron: '0 8 * * *',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_ACTION_NOT_ALLOWED');
    });

    test('rejects an invalid cron expression (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'schedule-badcron',
          type: 'schedule',
          target_type: 'orchestration',
          target_id: orchestrationId,
          cron: 'not a cron',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CRON_EXPRESSION');
    });

    test('rejects action on a non-tool target (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'orch-with-action',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          action: 'doThing',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_ACTION_NOT_ALLOWED');
    });

    test('rejects an mcp tool target without action (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'mcp-noaction',
          type: 'manual',
          target_type: 'tool',
          target_id: mcpToolId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_ACTION_NOT_ALLOWED');
    });

    test('creates an mcp tool trigger with an action', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'mcp-withaction',
          type: 'manual',
          target_type: 'tool',
          target_id: mcpToolId,
          action: 'someTool',
        });

      expect(res.status).toBe(201);
      expect(res.body.action).toBe('someTool');
    });

    test('rejects a client tool target (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'client-tool-trigger',
          type: 'manual',
          target_type: 'tool',
          target_id: clientToolId,
          action: 'x',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_ACTION_NOT_ALLOWED');
    });

    test('rejects a target that does not exist in the project (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'missing-target',
          type: 'manual',
          target_type: 'orchestration',
          target_id: 'orch_doesnotexist',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_TARGET_NOT_FOUND');
    });

    test('rejects a duplicate name in the same project (409)', async () => {
      await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
        project_id: projectId,
        name: 'dup-name',
        type: 'manual',
        target_type: 'orchestration',
        target_id: orchestrationId,
      });
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'dup-name',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('creates a trigger with an attached boundary policy', async () => {
      const policy = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'trigger-boundary',
          document: {
            statement: [{ effect: 'Allow', action: ['triggers:ListTriggers'] }],
          },
        });

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'with-policy',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          policy_id: policy.body.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.policy_id).toBe(policy.body.id);
    });

    test('rejects a non-existent policy_id (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'bad-policy',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          policy_id: 'pol_doesnotexist',
        });
      expect(res.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/triggers').send({
        project_id: projectId,
        name: 'noauth',
        type: 'manual',
        target_type: 'orchestration',
        target_id: orchestrationId,
      });
      expect(res.status).toBe(401);
    });

    test('user without triggers permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'noperm',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      expect(res.status).toBe(403);
    });

    test('no privilege escalation: create requires the target-start action (403)', async () => {
      const res = await authenticatedTestClient(limitedToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'escalation',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/triggers', () => {
    test('admin without project scoping gets an empty list', async () => {
      const res =
        await authenticatedTestClient(adminToken).get('/api/v1/triggers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    test('lists triggers in the project', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      // secrets never leak in list responses
      for (const t of res.body) {
        expect(t.secret).toBeUndefined();
      }
    });

    test('filters by type', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers?project_id=${projectId}&type=webhook`
      );
      expect(res.status).toBe(200);
      expect(
        res.body.every((t: { type: string }) => {
          return t.type === 'webhook';
        })
      ).toBe(true);
    });

    test('filters by target_type', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers?project_id=${projectId}&target_type=tool`
      );
      expect(res.status).toBe(200);
      expect(
        res.body.every((t: { target_type: string }) => {
          return t.target_type === 'tool';
        })
      ).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/triggers');
      expect(res.status).toBe(401);
    });

    test('user without permission scoped to project_id returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/triggers?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/triggers/:trigger_id', () => {
    let triggerId: string;

    beforeAll(async () => {
      triggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'get-one',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        })
      ).body.id;
    });

    test('returns a trigger by id without a secret', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers/${triggerId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(triggerId);
      expect(res.body.secret).toBeUndefined();
    });

    test('returns 404 for an unknown trigger', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/triggers/trg_missing'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(`/api/v1/triggers/${triggerId}`);
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/triggers/${triggerId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/triggers/:trigger_id', () => {
    let triggerId: string;

    beforeAll(async () => {
      triggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'patch-one',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          active: true,
        })
      ).body.id;
    });

    test('updates name and active', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ name: 'patch-one-renamed', active: false });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('patch-one-renamed');
      expect(res.body.active).toBe(false);
    });

    test('attaches a policy_id', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              { effect: 'Allow', action: ['orchestrations:StartRun'] },
            ],
          },
        });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ policy_id: policyRes.body.id });
      expect(res.status).toBe(200);
      expect(res.body.policy_id).toBe(policyRes.body.id);
    });

    test('clears a policy_id with null', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ policy_id: null });
      expect(res.status).toBe(200);
      expect(res.body.policy_id).toBeNull();
    });

    test('changing target_type re-validates the target and re-checks permission', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ target_type: 'tool', target_id: httpToolId });
      expect(res.status).toBe(200);
      expect(res.body.target_type).toBe('tool');
      expect(res.body.target_id).toBe(httpToolId);
    });

    test('changing target_type without the new target-start action returns 403', async () => {
      const orchTrigger = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'patch-no-escalation',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['triggers:UpdateTrigger', 'triggers:GetTrigger'],
              },
            ],
          },
        });
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'No CallTool Key',
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);

      const res = await authenticatedTestClient(keyRes.body.key as string)
        .patch(`/api/v1/triggers/${orchTrigger.body.id}`)
        .send({ target_type: 'tool', target_id: httpToolId });
      expect(res.status).toBe(403);
    });

    test('updating a schedule trigger with an invalid cron returns 400', async () => {
      const scheduleId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'patch-schedule',
          type: 'schedule',
          target_type: 'orchestration',
          target_id: orchestrationId,
          cron: '0 8 * * *',
        })
      ).body.id;

      const invalid = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${scheduleId}`)
        .send({ cron: 'bogus' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('INVALID_CRON_EXPRESSION');

      // A valid cron update recomputes next_fire_at.
      const valid = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${scheduleId}`)
        .send({ cron: '30 9 * * 1' });
      expect(valid.status).toBe(200);
      expect(valid.body.cron).toBe('30 9 * * 1');
      expect(valid.body.next_fire_at).toBeTruthy();
    });

    test('returns 404 for an unknown trigger', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch('/api/v1/triggers/trg_missing')
        .send({ name: 'x' });
      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ name: 'x' });
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/triggers/${triggerId}`)
        .send({ name: 'x' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/triggers/:trigger_id', () => {
    let triggerId: string;

    beforeAll(async () => {
      triggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'delete-one',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        })
      ).body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.delete(`/api/v1/triggers/${triggerId}`);
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/triggers/${triggerId}`
      );
      expect(res.status).toBe(403);
    });

    test('deletes a trigger', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/triggers/${triggerId}`
      );
      expect(res.status).toBe(204);

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers/${triggerId}`
      );
      expect(after.status).toBe(404);
    });

    test('returns 404 for an unknown trigger', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        '/api/v1/triggers/trg_missing'
      );
      expect(res.status).toBe(404);
    });
  });

  describe('trigger secrets', () => {
    let webhookTriggerId: string;
    let manualTriggerId: string;
    let initialSecret: string;

    beforeAll(async () => {
      const wh = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'secret-webhook',
          type: 'webhook',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      webhookTriggerId = wh.body.id;
      initialSecret = wh.body.secret;

      manualTriggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'secret-manual',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        })
      ).body.id;
    });

    test('GET secret returns the webhook secret', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers/${webhookTriggerId}/secret`
      );
      expect(res.status).toBe(200);
      expect(res.body.secret).toBe(initialSecret);
    });

    test('GET secret on a non-webhook trigger returns 400', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers/${manualTriggerId}/secret`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_ACTION_NOT_ALLOWED');
    });

    test('GET secret returns 404 for an unknown trigger', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/triggers/trg_missing/secret'
      );
      expect(res.status).toBe(404);
    });

    test('GET secret unauthenticated returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/triggers/${webhookTriggerId}/secret`
      );
      expect(res.status).toBe(401);
    });

    test('GET secret without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/triggers/${webhookTriggerId}/secret`
      );
      expect(res.status).toBe(403);
    });

    test('rotate-secret returns a new secret', async () => {
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/triggers/${webhookTriggerId}/rotate-secret`
      );
      expect(res.status).toBe(200);
      expect(typeof res.body.secret).toBe('string');
      expect(res.body.secret).not.toBe(initialSecret);

      // the new secret is now returned by GET secret
      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers/${webhookTriggerId}/secret`
      );
      expect(after.body.secret).toBe(res.body.secret);
    });

    test('rotate-secret on a non-webhook trigger returns 400', async () => {
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/triggers/${manualTriggerId}/rotate-secret`
      );
      expect(res.status).toBe(400);
    });

    test('rotate-secret unauthenticated returns 401', async () => {
      const res = await testClient.post(
        `/api/v1/triggers/${webhookTriggerId}/rotate-secret`
      );
      expect(res.status).toBe(401);
    });

    test('rotate-secret without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/triggers/${webhookTriggerId}/rotate-secret`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/triggers/:trigger_id/fire', () => {
    let orchTriggerId: string;
    let agentTriggerId: string;
    let inactiveTriggerId: string;

    beforeAll(async () => {
      orchTriggerId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/triggers')
          .send({
            project_id: projectId,
            name: 'fire-orch',
            type: 'manual',
            target_type: 'orchestration',
            target_id: orchestrationId,
            input: { seed: 1 },
          })
      ).body.id;

      agentTriggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'fire-agent',
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
        })
      ).body.id;

      inactiveTriggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'fire-inactive',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          active: false,
        })
      ).body.id;
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('fires an orchestration trigger synchronously and records a firing', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${orchTriggerId}/fire`)
        .send({ input: { extra: 2 } });

      expect(res.status).toBe(200);
      expect(res.body.id).toMatch(/^trg_fire_/);
      expect(res.body.source).toBe('manual');
      expect(res.body.status).toBe('succeeded');
      expect(res.body.result.target_type).toBe('orchestration');
      expect(res.body.result.result_id).toMatch(/^orch_run_/);
      // effective input is the shallow merge of static + fire-time input
      expect(res.body.input).toEqual({ seed: 1, extra: 2 });
      expect(res.body.completed_at).toBeTruthy();
    });

    test('fires a tool trigger and records the firing outcome', async () => {
      const toolTriggerId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/triggers')
          .send({
            project_id: projectId,
            name: 'fire-tool',
            type: 'manual',
            target_type: 'tool',
            target_id: httpToolId,
            input: { url: 'https://example.invalid' },
          })
      ).body.id;

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${toolTriggerId}/fire`)
        .send({});

      // The firing always yields an auditable record; a bare http tool with no
      // reachable endpoint records a `failed` outcome rather than throwing.
      expect(res.status).toBe(200);
      expect(res.body.result?.target_type ?? 'tool').toBe('tool');
      expect(['succeeded', 'failed']).toContain(res.body.status);
      if (res.body.status === 'failed') {
        expect(res.body.error).toBeTruthy();
      }
    });

    test('fires an agent trigger with a verbatim messages array', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_fire_msgs',
        traceId: 'trc_2',
        status: 'completed',
        output: { model: 'llama3.2', content: 'ok', finishReason: 'stop' },
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${agentTriggerId}/fire`)
        .send({
          input: { messages: [{ role: 'user', content: 'from array' }] },
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('succeeded');
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'from array' }],
        })
      );
    });

    test('fires an agent trigger with a generic object input', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_fire_obj',
        traceId: 'trc_3',
        status: 'completed',
        output: { model: 'llama3.2', content: 'ok', finishReason: 'stop' },
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${agentTriggerId}/fire`)
        .send({ input: { topic: 'weather', when: 'today' } });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('succeeded');
      // a non-empty object with no message/messages is JSON-encoded into one user message
      const call = mockCreateGeneration.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0].role).toBe('user');
      expect(call.messages[0].content).toContain('weather');
    });

    test('fires an agent trigger using the mocked generation boundary', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_fire_1',
        traceId: 'trc_1',
        status: 'completed',
        output: { model: 'llama3.2', content: 'ok', finishReason: 'stop' },
      });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${agentTriggerId}/fire`)
        .send({ input: { message: 'hello' } });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('succeeded');
      expect(res.body.result.target_type).toBe('agent');
      expect(res.body.result.result_id).toBe('gen_fire_1');
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          messages: [{ role: 'user', content: 'hello' }],
        })
      );
    });

    test('empty agent input returns 400 TRIGGER_INPUT_INVALID', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${agentTriggerId}/fire`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_INPUT_INVALID');
    });

    test('firing an inactive trigger returns 409', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${inactiveTriggerId}/fire`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRIGGER_NOT_ACTIVE');
    });

    test('unauthenticated fire returns 401', async () => {
      const res = await testClient
        .post(`/api/v1/triggers/${orchTriggerId}/fire`)
        .send({});
      expect(res.status).toBe(401);
    });

    test('fire without triggers:FireTrigger returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/triggers/${orchTriggerId}/fire`)
        .send({});
      expect(res.status).toBe(403);
    });

    test('recursion guard: a trigger run-as token cannot fire (403)', async () => {
      // Mint a trigger run-as token for a real user so the auth middleware
      // populates authUser and marks it as a trigger token.
      const users = (
        await authenticatedTestClient(adminToken).get('/api/v1/users')
      ).body;
      const myPublicId = users.find((u: { username: string; id: string }) => {
        return u.username === 'triggersuser';
      }).id;
      const trgToken = signTriggerToken({
        publicId: myPublicId,
        role: 'user',
        projectPublicId: projectId,
        triggerId: orchTriggerId,
      });

      const res = await authenticatedTestClient(trgToken)
        .post(`/api/v1/triggers/${orchTriggerId}/fire`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TRIGGER_RECURSION_FORBIDDEN');
    });

    test('a trigger run-as token is scoped by the attached boundary policy', async () => {
      // Boundary policy that allows only listing triggers.
      const policy = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'runas-boundary',
          document: {
            statement: [{ effect: 'Allow', action: ['triggers:ListTriggers'] }],
          },
        });
      const boundTrigger = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'runas-bound',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
          policy_id: policy.body.id,
        });

      const users = (
        await authenticatedTestClient(adminToken).get('/api/v1/users')
      ).body;
      const myPublicId = users.find((u: { username: string; id: string }) => {
        return u.username === 'triggersuser';
      }).id;
      const trgToken = signTriggerToken({
        publicId: myPublicId,
        role: 'user',
        projectPublicId: projectId,
        triggerId: boundTrigger.body.id,
      });

      // The boundary allows ListTriggers → the run-as token can list.
      const listRes = await authenticatedTestClient(trgToken).get(
        `/api/v1/triggers?project_id=${projectId}`
      );
      expect(listRes.status).toBe(200);

      // The boundary does NOT allow creating triggers → confined below the
      // creator's own (broader) permissions.
      const createRes = await authenticatedTestClient(trgToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'runas-should-fail',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      expect(createRes.status).toBe(403);
    });

    test('fails closed when the creator has been deleted (409)', async () => {
      // A throwaway user creates a trigger, then is deleted.
      await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'triggersephemeral', password: 'ephemeralpass' });
      const ephemeralUsers = (
        await authenticatedTestClient(adminToken).get('/api/v1/users')
      ).body;
      const ephemeralId = ephemeralUsers.find(
        (u: { username: string; id: string }) => {
          return u.username === 'triggersephemeral';
        }
      ).id;
      const ephemeralPolicy = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'triggers-ephemeral',
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['triggers:CreateTrigger', 'orchestrations:StartRun'],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${ephemeralId}/policies`)
        .send({ policy_ids: [ephemeralPolicy.body.id] });
      const ephemeralToken = await loginAs(
        'triggersephemeral',
        'ephemeralpass'
      );

      const ephemeralTrigger = await authenticatedTestClient(ephemeralToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'fire-ephemeral',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      expect(ephemeralTrigger.status).toBe(201);

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/users/${ephemeralId}`
      );
      expect(deleteRes.status).toBe(204);

      // admin (bypasses permission checks) fires the now-orphaned trigger
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/triggers/${ephemeralTrigger.body.id}/fire`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRIGGER_CREATOR_UNAVAILABLE');
    });
  });

  describe('orchestration input_schema validation at fire time', () => {
    let schemaTriggerId: string;

    beforeAll(async () => {
      const orch = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'schema-orch',
          nodes: [
            {
              id: 'start',
              type: 'transform',
              expression: { var: '' },
              state_mapping: { 'state.result': { var: 'output.output' } },
            },
          ],
          edges: [],
          input_schema: {
            type: 'object',
            required: ['count'],
            properties: { count: { type: 'integer' } },
          },
        });
      schemaTriggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'fire-schema',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orch.body.id,
        })
      ).body.id;
    });

    test('missing required input field returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${schemaTriggerId}/fire`)
        .send({ input: {} });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_INPUT_INVALID');
    });

    test('wrong input type returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${schemaTriggerId}/fire`)
        .send({ input: { count: 'not-a-number' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_INPUT_INVALID');
    });

    test('valid input fires successfully', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/triggers/${schemaTriggerId}/fire`)
        .send({ input: { count: 3 } });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('succeeded');
    });
  });

  describe('trigger firings queries', () => {
    let firedTriggerId: string;
    let firingId: string;

    beforeAll(async () => {
      firedTriggerId = (
        await authenticatedTestClient(userToken).post('/api/v1/triggers').send({
          project_id: projectId,
          name: 'firings-query',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        })
      ).body.id;
      firingId = (
        await authenticatedTestClient(userToken)
          .post(`/api/v1/triggers/${firedTriggerId}/fire`)
          .send({})
      ).body.id;
    });

    test('lists firings for a trigger', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/trigger-firings?trigger_id=${firedTriggerId}`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].trigger_id).toBe(firedTriggerId);
    });

    test('requires trigger_id (400)', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/trigger-firings'
      );
      expect(res.status).toBe(400);
    });

    test('accepts limit and offset query params', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/trigger-firings?trigger_id=${firedTriggerId}&limit=1&offset=0`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('gets a firing by id', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/trigger-firings/${firingId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(firingId);
      expect(res.body.status).toBe('succeeded');
    });

    test('unknown firing returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/trigger-firings/trg_fire_missing'
      );
      expect(res.status).toBe(404);
    });

    test('getting a firing by id without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/trigger-firings/${firingId}`
      );
      expect(res.status).toBe(403);
    });

    test('unauthenticated get firing by id returns 401', async () => {
      const res = await testClient.get(`/api/v1/trigger-firings/${firingId}`);
      expect(res.status).toBe(401);
    });

    test('unauthenticated firings list returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/trigger-firings?trigger_id=${firedTriggerId}`
      );
      expect(res.status).toBe(401);
    });

    test('firings list without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/trigger-firings?trigger_id=${firedTriggerId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('POST /hooks/triggers/:trigger_id (inbound)', () => {
    let hookTriggerId: string;
    let hookSecret: string;

    const sign = (secret: string, body: string) => {
      return `sha256=${crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex')}`;
    };

    const pollFiring = async (firingId: string) => {
      for (let i = 0; i < 20; i++) {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/trigger-firings/${firingId}`
        );
        if (
          res.status === 200 &&
          ['succeeded', 'failed'].includes(res.body.status)
        ) {
          return res.body;
        }
        await new Promise((r) => {
          setTimeout(r, 50);
        });
      }
      throw new Error('firing did not reach a terminal state');
    };

    beforeAll(async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'inbound-hook',
          type: 'webhook',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      hookTriggerId = created.body.id;
      hookSecret = created.body.secret;
    });

    test('accepts a validly-signed delivery with 202 and audits the firing', async () => {
      const body = JSON.stringify({ event: 'push', ref: 'main' });
      const res = await testClient
        .post(`/hooks/triggers/${hookTriggerId}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(hookSecret, body))
        .send(body);

      expect(res.status).toBe(202);
      expect(res.body.firing_id).toMatch(/^trg_fire_/);
      expect(res.body.trigger_id).toBe(hookTriggerId);
      expect(res.body.status).toBe('pending');

      const firing = await pollFiring(res.body.firing_id);
      expect(firing.source).toBe('webhook');
      expect(firing.status).toBe('succeeded');
      expect(firing.input).toEqual({ event: 'push', ref: 'main' });
    });

    test('wraps a non-object JSON body as { payload }', async () => {
      const body = '42';
      const res = await testClient
        .post(`/hooks/triggers/${hookTriggerId}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(hookSecret, body))
        .send(body);

      expect(res.status).toBe(202);
      const firing = await pollFiring(res.body.firing_id);
      expect(firing.input).toEqual({ payload: 42 });
    });

    test('missing signature returns 401', async () => {
      const body = JSON.stringify({ a: 1 });
      const res = await testClient
        .post(`/hooks/triggers/${hookTriggerId}`)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(401);
    });

    test('bad signature returns 401', async () => {
      const body = JSON.stringify({ a: 1 });
      const res = await testClient
        .post(`/hooks/triggers/${hookTriggerId}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign('wrong-secret', body))
        .send(body);
      expect(res.status).toBe(401);
    });

    test('unknown trigger returns 404', async () => {
      const body = JSON.stringify({ a: 1 });
      const res = await testClient
        .post('/hooks/triggers/trg_missing')
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(hookSecret, body))
        .send(body);
      expect(res.status).toBe(404);
    });

    test('non-webhook trigger returns 404 (existence not leaked)', async () => {
      const manual = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'inbound-manual',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      const body = JSON.stringify({ a: 1 });
      const res = await testClient
        .post(`/hooks/triggers/${manual.body.id}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(hookSecret, body))
        .send(body);
      expect(res.status).toBe(404);
    });

    test('inactive trigger returns 409 (only after a valid signature)', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'inbound-inactive',
          type: 'webhook',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ active: false });

      const body = JSON.stringify({ a: 1 });
      const res = await testClient
        .post(`/hooks/triggers/${created.body.id}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(created.body.secret, body))
        .send(body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRIGGER_NOT_ACTIVE');
    });

    test('invalid JSON body returns 400', async () => {
      const body = 'not-json{';
      const res = await testClient
        .post(`/hooks/triggers/${hookTriggerId}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(hookSecret, body))
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('HOOK_INVALID_JSON');
    });

    test('a body over 1 MiB returns 413', async () => {
      const body = JSON.stringify({ big: 'x'.repeat(1024 * 1024 + 10) });
      const res = await testClient
        .post(`/hooks/triggers/${hookTriggerId}`)
        .set('Content-Type', 'application/json')
        .set('X-Soat-Signature', sign(hookSecret, body))
        .send(body);
      expect(res.status).toBe(413);
    });
  });

  describe('cross-project isolation', () => {
    test('cannot bind a trigger in one project to a target from another', async () => {
      // orchestrationId lives in `projectId`. Creating a trigger scoped to
      // `otherProjectId` must not resolve that target — the target lookup is
      // confined to the trigger's project, so this fails at target validation.
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: otherProjectId,
          name: 'cross-project',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TRIGGER_TARGET_NOT_FOUND');
    });
  });

  // A project-scoped credential (project key / OAuth token) carries a policy
  // whose resources are SRN-scoped to the project, not the wildcard `*`. The
  // by-id handlers must authorize against a project SRN — not the implicit `*`
  // default — or such a principal can list but never get/update/delete.
  describe('SRN-scoped principal (project-scoped credential)', () => {
    let scopedToken: string;

    beforeAll(async () => {
      scopedToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'triggersscoped',
        actions: [
          'triggers:GetTrigger',
          'triggers:UpdateTrigger',
          'triggers:DeleteTrigger',
          'triggers:ListTriggerFirings',
        ],
      });
    });

    test('can get, list firings, update, and delete triggers', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: 'scoped-trigger',
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      const id = created.body.id;

      const getRes = await authenticatedTestClient(scopedToken).get(
        `/api/v1/triggers/${id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(id);

      const firingsRes = await authenticatedTestClient(scopedToken).get(
        `/api/v1/trigger-firings?trigger_id=${id}`
      );
      expect(firingsRes.status).toBe(200);

      const patchRes = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/triggers/${id}`)
        .send({ name: 'scoped-trigger-renamed' });
      expect(patchRes.status).toBe(200);

      const delRes = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/triggers/${id}`
      );
      expect(delRes.status).toBe(204);
    });
  });
});
