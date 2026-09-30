import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * An agent named by id resolves in the project it is used from. One in another
 * project answers exactly as an id that names nothing, so the response never
 * tells a caller that it exists elsewhere.
 */
describe('Cross-project agent references', () => {
  let adminToken: string;
  let scopedToken: string;
  let projectId: string;
  let otherProjectAgentId: string;

  const createAgent = async (args: { projectId: string; name: string }) => {
    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: args.projectId,
        name: `${args.name} Provider`,
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: args.projectId,
        ai_provider_id: provider.body.id,
        name: args.name,
      });
    expect(agent.status).toBe(201);
    return agent.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'xagentref',
      policyActions: [],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    scopedToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'xagentrefscoped',
      actions: [
        'agents:CreateSession',
        'actors:CreateActor',
        'actors:UpdateActor',
      ],
    });
    otherProjectAgentId = await createAgent({
      projectId: setup.otherProjectId as string,
      name: 'Other Project Agent',
    });
  });

  describe('POST /api/v1/sessions', () => {
    test('an agent in another project answers as an unknown one', async () => {
      const unknown = await authenticatedTestClient(scopedToken)
        .post('/api/v1/sessions')
        .send({ agent_id: 'agent_doesnotexist0' });
      const foreign = await authenticatedTestClient(scopedToken)
        .post('/api/v1/sessions')
        .send({ agent_id: otherProjectAgentId });

      expect(foreign.status).toBe(unknown.status);
      expect(foreign.body.error.code).toBe(unknown.body.error.code);
      expect(foreign.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/actors/:actor_id', () => {
    test('refuses an agent_id from another project', async () => {
      const actor = await authenticatedTestClient(scopedToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Linked Actor' });
      expect(actor.status).toBe(201);

      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/actors/${actor.body.id}`)
        .send({ agent_id: otherProjectAgentId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AGENT_NOT_FOUND');
    });
  });
});
