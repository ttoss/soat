import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// A user that can manage guardrails and the three attach targets, plus detach.
const ATTACH_ACTIONS = [
  'guardrails:CreateGuardrail',
  'guardrails:GetGuardrail',
  'guardrails:DeleteGuardrail',
  'guardrails:DetachGuardrail',
  'tools:CreateTool',
  'tools:GetTool',
  'tools:UpdateTool',
  'tools:DeleteTool',
  'agents:CreateAgent',
  'agents:GetAgent',
  'agents:UpdateAgent',
  'ai-providers:CreateAiProvider',
];

describe('Guardrail attachment (guardrail_ids)', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let guardrailId: string;
  let aiProviderId: string;

  const createGuardrail = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({ project_id: projectId, name, document: { class: 'C' } });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'gattach',
      policyActions: ATTACH_ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    guardrailId = await createGuardrail('Attachable Guardrail');

    const providerRes = await authenticatedTestClient(userToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Attach Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = providerRes.body.id;
  });

  describe('Tool scope', () => {
    test('creates a tool with an attached guardrail', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'Attached Tool',
          type: 'client',
          guardrail_ids: [guardrailId],
        });
      expect(res.status).toBe(201);
      expect(res.body.guardrail_ids).toEqual([guardrailId]);
    });

    test('attaches a guardrail via update', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'Plain Tool', type: 'client' });
      expect(createRes.body.guardrail_ids).toBeNull();

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tools/${createRes.body.id}`)
        .send({ guardrail_ids: [guardrailId] });
      expect(res.status).toBe(200);
      expect(res.body.guardrail_ids).toEqual([guardrailId]);
    });

    test('attaching a non-existent guardrail returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'Bad Attach',
          type: 'client',
          guardrail_ids: ['guard_doesnotexist00'],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GUARDRAIL_NOT_FOUND');
    });

    test('a guardrail from another project cannot be attached', async () => {
      const otherProjectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'gattach other' });
      const otherGuardrail = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: otherProjectRes.body.id,
          name: 'Foreign',
          document: { class: 'C' },
        });

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'Cross Project Attach',
          type: 'client',
          guardrail_ids: [otherGuardrail.body.id],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GUARDRAIL_NOT_FOUND');
    });
  });

  describe('Agent scope', () => {
    test('attaches and detaches a guardrail on an agent', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'Guarded Agent',
          guardrail_ids: [guardrailId],
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.guardrail_ids).toEqual([guardrailId]);

      const detachRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${createRes.body.id}`)
        .send({ guardrail_ids: [] });
      expect(detachRes.status).toBe(200);
      expect(detachRes.body.guardrail_ids).toEqual([]);
    });
  });

  describe('Project scope', () => {
    test('admin attaches a guardrail at the project scope', async () => {
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ guardrail_ids: [guardrailId] });
      expect(res.status).toBe(200);
      expect(res.body.guardrail_ids).toEqual([guardrailId]);

      // Detach again so it doesn't block the delete-409 test's own guardrail.
      const detach = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ guardrail_ids: [] });
      expect(detach.body.guardrail_ids).toEqual([]);
    });
  });

  describe('Detach permission gating', () => {
    test('removing an attached id without DetachGuardrail returns 403', async () => {
      // A tool carrying an attached guardrail.
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'Detach Guarded Tool',
          type: 'client',
          guardrail_ids: [guardrailId],
        });
      const toolId = toolRes.body.id;

      // A principal that can update tools but has NO detach permission.
      const noDetachToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'gattachnodetach',
        actions: ['tools:UpdateTool', 'tools:GetTool'],
      });

      // Adding an id is fine (tighten-only) — but this is a removal.
      const res = await authenticatedTestClient(noDetachToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ guardrail_ids: [] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      // The same principal CAN add another guardrail (tighten-only) without detach.
      const another = await createGuardrail('Second Guardrail');
      const addRes = await authenticatedTestClient(noDetachToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ guardrail_ids: [guardrailId, another] });
      expect(addRes.status).toBe(200);
      expect(addRes.body.guardrail_ids).toEqual([guardrailId, another]);
    });
  });

  describe('DELETE guardrail while referenced', () => {
    test('is blocked with 409 (listing every referencing scope) until detached', async () => {
      const doomed = await createGuardrail('Doomed Guardrail');

      // Reference from a tool AND an agent, so the 409 meta enumerates both
      // scopes.
      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'Referencing Tool',
          type: 'client',
          guardrail_ids: [doomed],
        });
      const toolId = toolRes.body.id;

      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'Referencing Agent',
          guardrail_ids: [doomed],
        });
      const agentId = agentRes.body.id;

      const blocked = await authenticatedTestClient(userToken).delete(
        `/api/v1/guardrails/${doomed}`
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('GUARDRAIL_HAS_REFERENCES');
      expect(blocked.body.error.meta.references.tools).toContain(toolId);
      expect(blocked.body.error.meta.references.agents).toContain(agentId);

      // Detach both, then deletion succeeds.
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ guardrail_ids: [] });
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ guardrail_ids: [] });

      const ok = await authenticatedTestClient(userToken).delete(
        `/api/v1/guardrails/${doomed}`
      );
      expect(ok.status).toBe(204);
    });
  });

  test('unauthenticated tool update is 401', async () => {
    const res = await testClient
      .patch('/api/v1/tools/tool_whatever')
      .send({ guardrail_ids: [] });
    expect(res.status).toBe(401);
  });
});
