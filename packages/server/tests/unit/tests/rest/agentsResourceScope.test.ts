import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Agents authorize per agent, not per project: a policy naming one agent's SRN
 * reaches that agent and refuses its siblings, on every route that acts on one.
 *
 * This is what lets an agent `boundary_policy` be scoped to an agent too — the
 * boundary and the caller policy have to answer the same question about the
 * same call, so the route's own check is the granularity the boundary may
 * promise (#1323).
 */
describe('a policy scoped to one agent does not reach another', () => {
  let adminToken: string;
  let projectId: string;
  let scopedToken: string;
  let allowedAgentId: string;
  let otherAgentId: string;

  const AGENT_ACTIONS = [
    'agents:GetAgent',
    'agents:UpdateAgent',
    'agents:DeleteAgent',
    'agents:ListAgents',
    'agents:ListAgentVersions',
    'agents:GetAgentVersion',
    'agents:RestoreAgentVersion',
    'agents:SetAgentRelease',
    'agents:CreateAgentGeneration',
  ];

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'agentscope',
      policyActions: AGENT_ACTIONS,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Scope Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const allowed = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'Scoped Agent',
        ai_provider_id: provider.body.id,
      });
    allowedAgentId = allowed.body.id;

    const other = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'Other Agent',
        ai_provider_id: provider.body.id,
      });
    otherAgentId = other.body.id;

    // A user whose only grant names one agent, so every refusal below is the
    // resource check rather than a missing action.
    const scopedUser = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'agentscopescoped', password: 'agentScopePass1' });
    const scopedPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: AGENT_ACTIONS,
              resource: [`srn:${projectId}:agent:${allowedAgentId}`],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${scopedUser.body.id}/policies`)
      .send({ policy_ids: [scopedPolicy.body.id] });
    scopedToken = await loginAs('agentscopescoped', 'agentScopePass1');
  });

  describe('GET /api/v1/agents/:agent_id', () => {
    test('reaches the agent the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/agents/${allowedAgentId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedAgentId);
    });

    // A read the caller may not perform is indistinguishable from absence,
    // which is the shape this module already answered for a cross-project read
    // and keeps here for a sibling.
    test('hides a sibling agent in the same project', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/agents/${otherAgentId}`
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/agents/:agent_id', () => {
    test('refuses a sibling agent', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/agents/${otherAgentId}`)
        .send({ instructions: 'Rewritten by an agent I may not touch.' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the agent the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/agents/${allowedAgentId}`)
        .send({ instructions: 'Be concise.' });

      expect(response.status).toBe(200);
      expect(response.body.instructions).toBe('Be concise.');
    });
  });

  describe('DELETE /api/v1/agents/:agent_id', () => {
    test('refuses a sibling agent', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/agents/${otherAgentId}`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('GET /api/v1/agents/:agent_id/versions', () => {
    test('hides a sibling agent', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/agents/${otherAgentId}/versions`
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('reaches the agent the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/agents/${allowedAgentId}/versions`
      );

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/agents/:agent_id/release/promote', () => {
    test('refuses a sibling agent', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/agents/${otherAgentId}/release/promote`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('refuses a sibling agent', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/agents/${otherAgentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('GET /api/v1/agents', () => {
    // The listing is project-scoped for every module: it probes the caller's
    // policy with `srn:<project>:agent:*`, which a statement naming one agent
    // cannot match, so a scoped policy lists nothing rather than listing the
    // one agent it names. Narrowing a listing by resource is the same change
    // for actors, documents and the rest, so it is not this one — pinned here
    // so the difference is deliberate rather than discovered.
    test('a policy scoped to one agent cannot list agents', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/agents?project_id=${projectId}`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });
});
