/**
 * Validates the onDelete FK rules added to Sequelize model associations.
 *
 * Each test follows the pattern:
 *   1. Create parent + child records
 *   2. Delete parent
 *   3. Assert child is CASCADE-deleted (returns null from DB) or has
 *      SET NULL FK field (field is null in the DB row)
 */

import { db } from 'src/db';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('FK onDelete rules', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let internalProjectId: number;

  // ── Setup ─────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'fkodadmin', password: 'supersecret' });

    adminToken = await loginAs('fkodadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'fkoduser', password: 'fkodpass' });
    userToken = await loginAs('fkoduser', 'fkodpass');
    const userId = createUserRes.body.id;

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'FK onDelete Test Project' });
    projectId = projectRes.body.id;

    const projectRow = await db.Project.findOne({
      where: { publicId: projectId },
    });
    internalProjectId = projectRow!.id as number;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'actors:CreateActor',
                'actors:GetActor',
                'actors:DeleteActor',
                'agents:CreateAgent',
                'agents:DeleteAgent',
                'agents:CreateSession',
                'memories:CreateMemory',
                'memories:DeleteMemory',
                'memories:CreateMemoryEntry',
                'memories:GetMemoryEntry',
                'formations:CreateFormation',
                'formations:DeleteFormation',
              ],
            },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  const createAiProvider = async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `fkod-provider-${Date.now()}`,
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    return res.body.id as string;
  };

  const createAgent = async (aiProviderId: string) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: `fkod-agent-${Date.now()}`,
      });
    return res.body.id as string;
  };

  const createMemory = async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name: `fkod-mem-${Date.now()}` });
    return res.body.id as string;
  };

  // ── CASCADE: Memory → MemoryEntry ─────────────────────────────────────────

  describe('Memory deleted → MemoryEntries are CASCADE-deleted', () => {
    test('entry is gone after parent memory is deleted', async () => {
      const memId = await createMemory();

      const entryRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/memories/${memId}/entries`)
        .send({ content: 'test entry for cascade' });
      expect(entryRes.status).toBe(201);
      const entryId = entryRes.body.id;

      // Confirm entry exists
      const beforeGet = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${memId}/entries/${entryId}`
      );
      expect(beforeGet.status).toBe(200);

      // Delete parent memory
      const delRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/memories/${memId}`
      );
      expect(delRes.status).toBe(204);

      // Entry must be gone from the DB
      const entry = await db.MemoryEntry.findOne({
        where: { publicId: entryId },
      });
      expect(entry).toBeNull();
    });
  });

  // ── CASCADE: Agent → Session ──────────────────────────────────────────────

  describe('Agent deleted → Sessions are CASCADE-deleted', () => {
    test('session is gone from DB after agent is deleted', async () => {
      const aiProviderId = await createAiProvider();
      const agentPublicId = await createAgent(aiProviderId);

      const agentRow = await db.Agent.findOne({
        where: { publicId: agentPublicId },
      });
      const agentDbId = agentRow!.id as number;

      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentPublicId}/sessions`)
        .send({});
      expect(sessionRes.status).toBe(201);
      const sessionPublicId = sessionRes.body.id as string;

      // Confirm session exists in DB
      const before = await db.Session.findOne({
        where: { publicId: sessionPublicId },
      });
      expect(before).not.toBeNull();

      // Delete the agent
      const delRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentPublicId}`
      );
      expect(delRes.status).toBe(204);

      // Session must have been cascade-deleted
      const after = await db.Session.findOne({
        where: { publicId: sessionPublicId },
      });
      expect(after).toBeNull();

      // No orphaned sessions in the DB for this agent's internal id
      const orphans = await db.Session.findAll({
        where: { agentId: agentDbId },
      });
      expect(orphans).toHaveLength(0);
    });
  });

  // ── CASCADE: Formation → FormationOperation and FormationResource ──────────

  describe('Formation deleted → FormationOperations and FormationResources are CASCADE-deleted', () => {
    test('operations and resources are gone from DB after formation row is physically deleted', async () => {
      const formRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `fkod-formation-${Date.now()}`,
          template: {
            resources: {
              TestMemory: {
                type: 'memory',
                properties: { name: `fkod-form-mem-${Date.now()}` },
              },
            },
          },
        });
      expect(formRes.status).toBe(201);
      const formationPublicId = formRes.body.id as string;

      const formRow = await db.Formation.findOne({
        where: { publicId: formationPublicId },
      });
      expect(formRow).not.toBeNull();
      const formDbId = formRow!.id as number;

      // Confirm at least one resource and one operation were created
      const resources = await db.FormationResource.findAll({
        where: { formationId: formDbId },
      });
      expect(resources.length).toBeGreaterThan(0);

      const operations = await db.FormationOperation.findAll({
        where: { formationId: formDbId },
      });
      expect(operations.length).toBeGreaterThan(0);

      // Physically destroy the formation row (bypasses the soft-delete business
      // logic) to trigger the CASCADE constraints at the DB level.
      await formRow!.destroy();

      // Resources and operations must be cascade-deleted
      const resourcesAfter = await db.FormationResource.findAll({
        where: { formationId: formDbId },
      });
      expect(resourcesAfter).toHaveLength(0);

      const operationsAfter = await db.FormationOperation.findAll({
        where: { formationId: formDbId },
      });
      expect(operationsAfter).toHaveLength(0);
    });
  });

  // ── SET NULL: Agent deleted → Actor.agentId is null ───────────────────────

  describe('Agent deleted → Actor.agentId is SET NULL', () => {
    test('actor.agent_id becomes null after linked agent is deleted', async () => {
      const aiProviderId = await createAiProvider();
      const agentId = await createAgent(aiProviderId);

      const actorRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'fkod-actor-agent',
          agent_id: agentId,
        });
      expect(actorRes.status).toBe(201);
      const actorId = actorRes.body.id as string;
      expect(actorRes.body.agent_id).toBe(agentId);

      // Delete the agent
      const delRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentId}`
      );
      expect(delRes.status).toBe(204);

      // Actor must still exist, but agent_id is now null
      const actorAfter = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}`
      );
      expect(actorAfter.status).toBe(200);
      expect(actorAfter.body.agent_id).toBeNull();
    });
  });

  // ── SET NULL: Memory deleted → Actor.memoryId is null ─────────────────────

  describe('Memory deleted → Actor.memoryId is SET NULL', () => {
    test('actor.memory_id becomes null after linked memory is deleted', async () => {
      const memId = await createMemory();

      const actorRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'fkod-actor-mem', memory_id: memId });
      expect(actorRes.status).toBe(201);
      const actorId = actorRes.body.id as string;
      expect(actorRes.body.memory_id).toBe(memId);

      // Delete the memory
      const delRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/memories/${memId}`
      );
      expect(delRes.status).toBe(204);

      // Actor must still exist, but memory_id is now null
      const actorAfter = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}`
      );
      expect(actorAfter.status).toBe(200);
      expect(actorAfter.body.memory_id).toBeNull();
    });
  });

  // ── SET NULL: Actor deleted → Session.actorId is null ─────────────────────

  describe('Actor deleted → Session.actorId is SET NULL', () => {
    test('session.actorId becomes null in DB after linked actor is deleted', async () => {
      const aiProviderId = await createAiProvider();
      const agentPublicId = await createAgent(aiProviderId);

      const actorRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'fkod-actor-for-session' });
      expect(actorRes.status).toBe(201);
      const actorPublicId = actorRes.body.id as string;

      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentPublicId}/sessions`)
        .send({ actor_id: actorPublicId });
      expect(sessionRes.status).toBe(201);
      const sessionPublicId = sessionRes.body.id as string;
      expect(sessionRes.body.actor_id).toBe(actorPublicId);

      // Confirm actorId in DB
      const before = await db.Session.findOne({
        where: { publicId: sessionPublicId },
      });
      expect(before!.actorId).not.toBeNull();

      // Delete the actor
      const delRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/actors/${actorPublicId}`
      );
      expect(delRes.status).toBe(204);

      // Session must still exist, but actorId in the DB must be null
      const after = await db.Session.findOne({
        where: { publicId: sessionPublicId },
      });
      expect(after).not.toBeNull();
      expect(after!.actorId).toBeNull();
    });
  });
});
