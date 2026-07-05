import { updateConversationStatus } from 'src/lib/conversations';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// `updateConversationStatus` has no REST route of its own (status changes go
// through the generic PATCH /conversations/:id handler), so it is exercised
// directly here.
describe('updateConversationStatus', () => {
  let adminToken: string;
  let projectId: string;
  let conversationId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'updateConversationStatus Test Project' });
    projectId = projectRes.body.id;

    const conversationRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    conversationId = conversationRes.body.id;
  });

  test('updates the status and returns the mapped conversation', async () => {
    const result = await updateConversationStatus({
      id: conversationId,
      status: 'closed',
    });

    expect(result?.id).toBe(conversationId);
    expect(result?.status).toBe('closed');
  });

  test('returns null when the conversation does not exist', async () => {
    const result = await updateConversationStatus({
      id: 'cnv_nonexistent',
      status: 'closed',
    });

    expect(result).toBeNull();
  });
});
