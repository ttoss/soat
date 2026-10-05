import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

describe('PATCH /api/v1/agents/:agent_id — a partial update', () => {
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'agpartial',
      policyActions: [
        'agents:CreateAgent',
        'agents:GetAgent',
        'agents:UpdateAgent',
        'ai-providers:CreateAiProvider',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(userToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'agpartial-provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(providerRes.status).toBe(201);
    aiProviderId = providerRes.body.id;
  });

  test('a model-only update keeps the pinned provider', async () => {
    const created = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'agpartial-agent',
        ai_provider_id: aiProviderId,
      });
    expect(created.status).toBe(201);

    const res = await authenticatedTestClient(userToken)
      .patch(`/api/v1/agents/${created.body.id}`)
      .send({ model: 'llama3.1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: created.body.id,
      model: 'llama3.1',
      ai_provider_id: aiProviderId,
    });
  });
});
