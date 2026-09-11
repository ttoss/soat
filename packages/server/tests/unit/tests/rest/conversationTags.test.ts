import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

describe('ConversationTags', () => {
  let userToken: string;
  let projectId: string;

  const createConversation = async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'convtags',
      policyActions: [
        'conversations:ListConversations',
        'conversations:GetConversation',
        'conversations:CreateConversation',
        'conversations:UpdateConversation',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  describe('tag body validation', () => {
    let conversationId: string;

    beforeAll(async () => {
      conversationId = await createConversation();
    });

    test('PUT rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/conversations/${conversationId}/tags`)
        .send({ team: 5 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('PATCH rejects an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/conversations/${conversationId}/tags`)
        .send(['a']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/conversations with tag filter', () => {
    let taggedId: string;
    let otherId: string;

    beforeAll(async () => {
      taggedId = await createConversation();
      await authenticatedTestClient(userToken)
        .put(`/api/v1/conversations/${taggedId}/tags`)
        .send({ channel: 'whatsapp' });

      otherId = await createConversation();
      await authenticatedTestClient(userToken)
        .put(`/api/v1/conversations/${otherId}/tags`)
        .send({ channel: 'email' });
    });

    test('a key:value pair returns only conversations carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/conversations')
        .query({ project_id: projectId, tags: 'channel:whatsapp' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((c: { id: string }) => {
        return c.id;
      });
      expect(ids).toContain(taggedId);
      expect(ids).not.toContain(otherId);
    });

    test('a pair without a colon is rejected', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/conversations')
        .query({ project_id: projectId, tags: 'whatsapp' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
