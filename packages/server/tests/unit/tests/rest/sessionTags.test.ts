import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

describe('SessionTags', () => {
  let userToken: string;
  let agentId: string;

  const createSession = async (name: string) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, name });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'sesstags',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateSession',
        'agents:ListSessions',
        'agents:GetSession',
        'agents:UpdateSession',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;

    const aiProvRes = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: setup.projectId,
        name: 'Session Tags Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: aiProvRes.body.id,
        name: 'Session Tags Agent',
      });
    agentId = agentRes.body.id;
  });

  describe('tag body validation', () => {
    let sessionId: string;

    beforeAll(async () => {
      sessionId = await createSession('Tag Validation');
    });

    test('PUT tags rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/sessions/${sessionId}/tags`)
        .send({ team: ['a'] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('PATCH tags rejects an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/sessions/${sessionId}/tags`)
        .send(['a']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/sessions with tag filter', () => {
    let taggedId: string;
    let otherId: string;

    beforeAll(async () => {
      taggedId = await createSession('Tagged Session');
      await authenticatedTestClient(userToken)
        .put(`/api/v1/sessions/${taggedId}/tags`)
        .send({ experiment: 'prompt-v2' });

      otherId = await createSession('Other Session');
      await authenticatedTestClient(userToken)
        .put(`/api/v1/sessions/${otherId}/tags`)
        .send({ experiment: 'prompt-v1' });
    });

    test('a key:value pair returns only sessions carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/sessions')
        .query({ agent_id: agentId, tags: 'experiment:prompt-v2' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((s: { id: string }) => {
        return s.id;
      });
      expect(ids).toContain(taggedId);
      expect(ids).not.toContain(otherId);
    });

    test('a pair without a colon is rejected', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/sessions')
        .query({ agent_id: agentId, tags: 'prompt-v2' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
