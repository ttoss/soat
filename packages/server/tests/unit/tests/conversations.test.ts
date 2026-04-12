import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authenticatedTestClient, loginAs, testClient } from '../testClient';

jest.mock('src/lib/embedding', () => {
  return {
    getEmbedding: jest.fn().mockResolvedValue(Array(1024).fill(0.1)),
  };
});

describe('Conversations', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let actorId: string;

  beforeAll(async () => {
    const storageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'soat-convo-test-')
    );
    process.env.FILES_STORAGE_DIR = storageDir;
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
    process.env.EMBEDDING_DIMENSIONS = '1024';

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
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(2);
    });

    test('listing without projectId returns all accessible conversations', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/conversations'
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
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
      expect(Array.isArray(response.body)).toBe(true);
      expect(
        response.body.some((c: { id: string }) => c.id === filteredConvId)
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
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(0);
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
        listRes.body.some(
          (m: { documentId: string }) => m.documentId === addedDocumentId
        )
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
        listRes.body.some(
          (m: { documentId: string }) => m.documentId === secondDocumentId
        )
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
      const ids = response.body.map((a: { id: string }) => a.id);
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
      expect(response.body.length).toBeGreaterThanOrEqual(1);
      expect(response.body[0].content).toBe('Content check message');
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
});
