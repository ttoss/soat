import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Conversations', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let actorId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'convouser', password: 'convopass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('convouser', 'convopass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Conversations Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: [
          'actors:CreateActor',
          'actors:ListActors',
          'actors:GetActor',
          'documents:CreateDocument',
          'documents:GetDocument',
          'conversations:ListConversations',
          'conversations:GetConversation',
          'conversations:CreateConversation',
          'conversations:UpdateConversation',
          'conversations:DeleteConversation',
          'conversations:GenerateConversationMessage',
          'actors:UpdateActor',
          'actors:DeleteActor',
        ],
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId, policyId });

    const actorRes = await authenticatedTestClient(userToken)
      .post('/api/v1/actors')
      .send({ projectId, name: 'ConvoActor' });
    actorId = actorRes.body.id;
  });

  describe('POST /api/v1/conversations', () => {
    test('authenticated user with permission can create a conversation', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^conv_/);
      expect(response.body.projectId).toBe(projectId);
      expect(response.body.status).toBe('open');
    });

    test('can create a conversation with closed status', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId, status: 'closed' });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('closed');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/conversations')
        .send({ projectId });

      expect(response.status).toBe(401);
    });

    test('missing projectId returns 400 for JWT users', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/conversations', () => {
    beforeAll(async () => {
      await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
    });

    test('authenticated user with permission can list conversations', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations?projectId=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);
    });

    test('listing without projectId returns all accessible conversations', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/conversations'
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('can filter by actorId', async () => {
      const secondActorRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ projectId, name: 'FilterActor' });
      const secondActorId = secondActorRes.body.id;

      const convRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      const filteredConvId = convRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${filteredConvId}/messages`)
        .send({ message: 'Filter test', actorId: secondActorId });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations?actorId=${secondActorId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(
        response.body.data.some((c: { id: string }) => {
          return c.id === filteredConvId;
        })
      ).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/conversations?projectId=${projectId}`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/conversations/:id', () => {
    let conversationId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = res.body.id;
    });

    test('user with permission can get a conversation by ID', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(conversationId);
      expect(response.body.status).toBe('open');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/conversations/${conversationId}`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent conversation', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/conversations/conv_nonexistent'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/conversations/:id', () => {
    let conversationId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = res.body.id;
    });

    test('user with permission can update conversation status', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/conversations/${conversationId}`)
        .send({ status: 'closed' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(conversationId);
      expect(response.body.status).toBe('closed');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/conversations/${conversationId}`)
        .send({ status: 'open' });

      expect(response.status).toBe(401);
    });

    test('missing status returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/conversations/${conversationId}`)
        .send({});

      expect(response.status).toBe(400);
    });

    test('returns 404 for non-existent conversation', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/conversations/conv_nonexistent')
        .send({ status: 'open' });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/conversations/:id/messages', () => {
    let conversationId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = res.body.id;
    });

    test('user with permission can list messages (empty initially)', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${conversationId}/messages`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/conversations/${conversationId}/messages`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent conversation', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/conversations/conv_nonexistent/messages'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/conversations/:id/messages', () => {
    let conversationId: string;
    let addedDocumentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = res.body.id;
    });

    test('user with permission can add a message to a conversation', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ message: 'Hello world', actorId });

      expect(response.status).toBe(201);
      expect(response.body.documentId).toMatch(/^doc_/);
      expect(response.body.actorId).toBe(actorId);
      expect(typeof response.body.position).toBe('number');
      expect(response.body.content).toBe('Hello world');
      addedDocumentId = response.body.documentId;
    });

    test('message appears in list after adding', async () => {
      const listRes = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${conversationId}/messages`
      );

      expect(listRes.status).toBe(200);
      expect(
        listRes.body.data.some((m: { documentId: string }) => {
          return m.documentId === addedDocumentId;
        })
      ).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ message: 'test' });

      expect(response.status).toBe(401);
    });

    test('missing message returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({});

      expect(response.status).toBe(400);
    });

    test('returns 404 for non-existent conversation', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/conversations/conv_nonexistent/messages')
        .send({ message: 'Hello world', actorId });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/conversations/:id/messages/:documentId', () => {
    let conversationId: string;
    let secondDocumentId: string;

    beforeAll(async () => {
      const convRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = convRes.body.id;

      const msgRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ message: 'Remove me', actorId });
      secondDocumentId = msgRes.body.documentId;
    });

    test('user with permission can remove a message', async () => {
      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/conversations/${conversationId}/messages/${secondDocumentId}`
      );

      expect(deleteRes.status).toBe(204);

      const listRes = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${conversationId}/messages`
      );
      expect(
        listRes.body.data.some((m: { documentId: string }) => {
          return m.documentId === secondDocumentId;
        })
      ).toBe(false);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        `/api/v1/conversations/${conversationId}/messages/doc_nonexistent`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent message', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        `/api/v1/conversations/${conversationId}/messages/doc_nonexistent`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/conversations/:id', () => {
    test('user with permission can delete a conversation', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      const conversationId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/conversations/${conversationId}`
      );

      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${conversationId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });

      const response = await testClient.delete(
        `/api/v1/conversations/${createRes.body.id}`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent conversation', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/conversations/conv_nonexistent'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/conversations/:id/actors', () => {
    let conversationId: string;
    let secondActorIdForActorsTest: string;

    beforeAll(async () => {
      const convRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = convRes.body.id;

      const actorRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ projectId, name: 'SecondActorForActors' });
      secondActorIdForActorsTest = actorRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ message: 'Message from actor 1', actorId });
      await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({
          message: 'Message from actor 2',
          actorId: secondActorIdForActorsTest,
        });
      await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ message: 'Another from actor 1', actorId });
    });

    test('returns distinct actors who sent messages', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${conversationId}/actors`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(2);
      const ids = response.body.map((a: { id: string }) => {
        return a.id;
      });
      expect(ids).toContain(actorId);
      expect(ids).toContain(secondActorIdForActorsTest);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/conversations/${conversationId}/actors`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent conversation', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/conversations/conv_nonexistent/actors'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('Message content field', () => {
    let conversationId: string;

    beforeAll(async () => {
      const convRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = convRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ message: 'Content check message', actorId });
    });

    test('listed messages include content field', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${conversationId}/messages`
      );

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data[0].content).toBe('Content check message');
    });
  });

  describe('Message removal cleans up document', () => {
    let conversationId: string;
    let documentId: string;

    beforeAll(async () => {
      const convRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      conversationId = convRes.body.id;

      const msgRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ message: 'Orphan test message', actorId });
      documentId = msgRes.body.documentId;
    });

    test('removing a message also deletes the underlying document', async () => {
      // Verify document exists before removal
      const docBefore = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${documentId}`
      );
      expect(docBefore.status).toBe(200);

      // Remove the message
      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/conversations/${conversationId}/messages/${documentId}`
      );
      expect(deleteRes.status).toBe(204);

      // Verify document is also gone
      const docAfter = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${documentId}`
      );
      expect(docAfter.status).toBe(404);
    });
  });

  describe('Conversation name', () => {
    test('creates conversation with a name and exposes it on GET', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId, name: 'Support Case 42' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.name).toBe('Support Case 42');

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/conversations/${createRes.body.id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.name).toBe('Support Case 42');
    });

    test('updates a conversation name via PATCH', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId, name: 'Before' });
      const convId = createRes.body.id;

      const patchRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/conversations/${convId}`)
        .send({ name: 'After' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.name).toBe('After');
    });
  });

  describe('POST /api/v1/conversations/:id/generate', () => {
    let convId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      convId = res.body.id;
    });

    test('returns 400 when actorId is missing', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({});
      expect(res.status).toBe(400);
    });

    test('returns 501 when stream is requested', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ actorId, stream: true });
      expect(res.status).toBe(501);
    });

    test('returns 400 when actor has no agentId or chatId', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ actorId });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/agentId or chatId/i);
    });

    test('returns 404 for unknown conversation', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations/conv_does_not_exist/generate')
        .send({ actorId });
      expect(res.status).toBe(404);
    });

    test('returns 401 when unauthenticated', async () => {
      const res = await testClient
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ actorId });
      expect(res.status).toBe(401);
    });
  });

  describe('Actor agent/chat mutual exclusion', () => {
    test('rejects creating an actor with both agentId and chatId', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({
          projectId,
          name: 'Bad Actor',
          agentId: 'agt_fake',
          chatId: 'cht_fake',
        });
      expect(res.status).toBe(400);
    });

    test('rejects creating an actor with invalid agentId', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({
          projectId,
          name: 'Bad Actor 2',
          agentId: 'agt_does_not_exist',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('Actor deletion with messages', () => {
    test('returns 409 when deleting an actor that has conversation messages', async () => {
      // Create a fresh actor and conversation, add a message, then try delete.
      const newActorRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ projectId, name: 'ActorWithMessages' });
      expect(newActorRes.status).toBe(201);
      const newActorId = newActorRes.body.id;

      const convRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ projectId });
      const newConvId = convRes.body.id;

      const msgRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${newConvId}/messages`)
        .send({ actorId: newActorId, message: 'hello' });
      expect(msgRes.status).toBe(201);

      const delRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/actors/${newActorId}`
      );
      expect(delRes.status).toBe(409);
    });
  });
});
