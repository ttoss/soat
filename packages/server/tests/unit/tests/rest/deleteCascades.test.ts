import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * What deleting a parent does to the rows that point at it — the `onDelete`
 * rule on each foreign key, observed through the API: a `CASCADE` child is
 * gone, a `SET NULL` child survives with the link cleared. A rule missing from
 * the schema shows here as a `500` from the constraint, or as a child that
 * still answers.
 */
describe('Delete cascades', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createAgent = async (): Promise<string> => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: `cascade-agent-${seq}`,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'cascades',
      policyActions: [
        'actors:CreateActor',
        'actors:GetActor',
        'actors:DeleteActor',
        'agents:CreateAgent',
        'agents:DeleteAgent',
        'agents:CreateSession',
        'agents:GetSession',
        'memories:CreateMemoryStore',
        'memories:DeleteMemoryStore',
        'memories:CreateMemory',
        'memories:GetMemory',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'cascade-provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(provider.status).toBe(201);
    aiProviderId = provider.body.id;
  });

  describe('DELETE /api/v1/memory-stores/:memory_store_id', () => {
    test('takes the store’s memories with it', async () => {
      const store = await asUser()
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: 'cascade-store' });
      expect(store.status).toBe(201);
      const memory = await asUser()
        .post('/api/v1/memories')
        .send({ memory_store_id: store.body.id, content: 'cascade entry' });
      expect(memory.status).toBe(201);

      const deleted = await asUser().delete(
        `/api/v1/memory-stores/${store.body.id}`
      );
      expect(deleted.status).toBe(204);

      const after = await asUser().get(`/api/v1/memories/${memory.body.id}`);
      expect(after.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/agents/:agent_id', () => {
    test('takes the agent’s sessions with it and unlinks its actor', async () => {
      const agentId = await createAgent();
      const session = await asUser()
        .post('/api/v1/sessions')
        .send({ agent_id: agentId });
      expect(session.status).toBe(201);
      const actor = await asUser().post('/api/v1/actors').send({
        project_id: projectId,
        name: 'cascade-actor',
        agent_id: agentId,
      });
      expect(actor.status).toBe(201);
      expect(actor.body.agent_id).toBe(agentId);

      const deleted = await asUser().delete(`/api/v1/agents/${agentId}`);
      expect(deleted.status).toBe(204);

      const sessionAfter = await asUser().get(
        `/api/v1/sessions/${session.body.id}`
      );
      expect(sessionAfter.status).toBe(404);

      // The actor is its own resource: it survives, without the link.
      const actorAfter = await asUser().get(`/api/v1/actors/${actor.body.id}`);
      expect(actorAfter.status).toBe(200);
      expect(actorAfter.body.agent_id).toBeNull();
    });
  });

  describe('DELETE /api/v1/actors/:actor_id', () => {
    test('keeps the actor’s sessions, without the link', async () => {
      const agentId = await createAgent();
      const actor = await asUser()
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'cascade-session-actor' });
      expect(actor.status).toBe(201);
      const session = await asUser()
        .post('/api/v1/sessions')
        .send({ agent_id: agentId, actor_id: actor.body.id });
      expect(session.status).toBe(201);
      expect(session.body.actor_id).toBe(actor.body.id);

      const deleted = await asUser().delete(`/api/v1/actors/${actor.body.id}`);
      expect(deleted.status).toBe(204);

      const after = await asUser().get(`/api/v1/sessions/${session.body.id}`);
      expect(after.status).toBe(200);
      expect(after.body.actor_id).toBeNull();
    });
  });

  describe('DELETE /api/v1/projects/:project_id?force=true', () => {
    test('removes a formation together with its operations and resources', async () => {
      const project = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Cascade Formation Project' });
      expect(project.status).toBe(201);
      const formation = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: project.body.id,
          name: 'cascade-formation',
          template: {
            resources: {
              Store: {
                type: 'memory_store',
                properties: { name: 'cascade-formation-store' },
              },
            },
          },
        });
      expect(formation.status).toBe(201);

      // The formation's operation and resource rows are removed by the
      // database when the formation row goes, not by the force-delete walk.
      const deleted = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${project.body.id}?force=true`
      );
      expect(deleted.status).toBe(204);

      const after = await authenticatedTestClient(adminToken).get(
        `/api/v1/formations/${formation.body.id}`
      );
      expect(after.status).toBe(404);
    });
  });
});
