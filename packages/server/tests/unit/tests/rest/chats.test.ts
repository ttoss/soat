import * as chatsLib from 'src/lib/chats';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Chats', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let aiProviderId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'chats',
      policyActions: [
        'chats:CreateChat',
        'chats:ListChats',
        'chats:GetChat',
        'chats:DeleteChat',
        'chats:CreateChatCompletion',
        'chats:CreateChatCompletionForChat',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Chats Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
  });

  describe('POST /api/v1/chats', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId });

      expect(response.status).toBe(401);
    });

    test('missing aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('non-string aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ project_id: projectId, ai_provider_id: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('unknown aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          project_id: projectId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('creates a chat with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^chat_/);
      expect(response.body.ai_provider_id).toBe(aiProviderId);
      expect(response.body.project_id).toBe(projectId);
    });

    test('creates a chat with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'My Chat',
          system_message: 'You are a helpful assistant',
          model: 'llama3.2',
        });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('My Chat');
      expect(response.body.system_message).toBe('You are a helpful assistant');
      expect(response.body.model).toBe('llama3.2');
    });
  });

  describe('GET /api/v1/chats', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/chats');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/chats')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list chats', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/chats')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('GET /api/v1/chats/:chatId', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/chats/${chatId}`);
      expect(response.status).toBe(401);
    });

    test('unknown chatId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/chats/cht_doesnotexist0000'
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('authenticated user can get a chat', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/chats/${chatId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(chatId);
      expect(response.body.ai_provider_id).toBe(aiProviderId);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/chats/:chatId', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(`/api/v1/chats/${chatId}`);
      expect(response.status).toBe(401);
    });

    test('unknown chatId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/chats/cht_doesnotexist0000'
      );
      expect(response.status).toBe(404);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(403);
    });

    test('authenticated user can delete a chat', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(204);
    });

    test('deleted chat returns 404 on get', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/chats/:chatId/completions', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/chats/cht_someid/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(401);
    });

    test('missing messages returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const chatId = res.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty messages array returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const chatId = res.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('unknown chatId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/cht_doesnotexist0000/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const chatId = res.body.id;

      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/chat/completions', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/chat/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(401);
      expect(response.body.error).toBeDefined();
    });

    test('missing messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty messages array returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('non-array messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({ messages: 'hello' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('unknown aiProviderId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('missing ai_provider_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('POST /api/v1/chats/:chatId/completions - with mocked AI', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('returns 200 with completion result when createChatCompletionForChat succeeds', async () => {
      jest
        .spyOn(chatsLib, 'createChatCompletionForChat')
        .mockResolvedValueOnce({
          model: 'mock-model',
          content: 'Mock AI response',
          finishReason: 'stop',
        });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('chat.completion');
    });
  });

  describe('POST /api/v1/chat/completions - with mocked AI', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('returns 200 with completion result when createChatCompletion succeeds', async () => {
      jest.spyOn(chatsLib, 'createChatCompletion').mockResolvedValueOnce({
        model: 'direct-model',
        content: 'Direct completion response',
        finishReason: 'stop',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('chat.completion');
    });
  });

  // ── Streaming /chats/:chatId/completions ────────────────────────────────

  describe('POST /api/v1/chats/:chatId/completions - streaming (real lib)', () => {
    let chatId: string;
    let chatWithSystemId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;

      // Chat with a pre-configured system message to exercise buildChatFinalMessages
      const res2 = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          system_message: 'You are a helpful assistant.',
        });
      chatWithSystemId = res2.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }], stream: true });

      expect(response.status).toBe(401);
    });

    test('streams SSE response for existing chat', async () => {
      // Ollama is not running in tests; the stream will fail during iteration,
      // but the SSE response headers are set and the function body is fully exercised.
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }], stream: true });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(response.text).toContain('data:');
    });

    test('sends error via SSE for unknown chatId', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/cht_doesnotexist0000/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }], stream: true });

      expect(response.status).toBe(200);
      expect(response.text).toContain('not found');
    });

    test('streams SSE response when chat has a system message', async () => {
      // Exercises the system-message branch inside streamChatCompletionForChat
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatWithSystemId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }], stream: true });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    });

    test('streams SSE response when messages include a system message', async () => {
      // Exercises the systemFromRequest branch inside streamChatCompletionForChat
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' },
          ],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    });
  });

  // ── Streaming /chat/completions ─────────────────────────────────────────

  describe('POST /api/v1/chat/completions - streaming (real lib)', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/chat/completions').send({
        ai_provider_id: aiProviderId,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });

      expect(response.status).toBe(401);
    });

    test('streams SSE response with ai_provider_id', async () => {
      // resolveModel + buildModel + getProviderFactory are exercised for the Ollama provider.
      // The stream iteration fails (Ollama not running), caught by the error handler.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(response.text).toContain('data:');
    });

    test('missing ai_provider_id returns 400 (streaming)', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('non-streaming request reaches createChatCompletion (propagates AI error status)', async () => {
      // createChatCompletion runs its system/non-system message split before
      // calling generateText, which throws because this suite has no live
      // Ollama server (only the smoke/tutorials CI jobs set one up) — the
      // connection failure surfaces as an unhandled error, i.e. 500.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' },
          ],
        });

      expect(response.status).toBe(500);
    });
  });

  // ── Real createChatCompletionForChat execution (admin) ──────────────────

  describe('POST /api/v1/chats/:chatId/completions - real lib paths (admin)', () => {
    let realChatId: string;
    let openAiProviderId: string;

    beforeAll(async () => {
      const chatRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      realChatId = chatRes.body.id;

      // openai provider to exercise getProviderFactory openai branch
      const aiRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'OpenAI Path Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      openAiProviderId = aiRes.body.id;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('non-streaming completions with ollama provider (reaches generateText, propagates AI error status)', async () => {
      // createChatCompletionForChat runs getChatSystemMessage +
      // buildChatFinalMessages before calling generateText, which throws
      // because this suite has no live Ollama server — same reasoning as
      // the chat/completions test above.
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/chats/${realChatId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(res.status).toBe(500);
    });

    test('openai provider exercises getProviderFactory openai branch and buildModel factory-true branch (streaming)', async () => {
      // isOpenAILikeProvider('openai') = true → factory is non-null → buildModel uses factory.
      // OpenAI API fails (no valid key) → error written to SSE stream.
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: openAiProviderId,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        });

      expect(res.status).toBe(200);
      expect(res.text).toContain('data:');
    });
  });

  // ── Actor linked to a chat (via POST /actors + chat_id) ─────────────────
  // The former POST /chats/:id/actors was removed; an actor is now linked to a
  // chat by passing chat_id to the top-level /actors collection, and listed
  // back with the ?chat_id= filter.

  describe('actor ↔ chat link via /actors', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    test('admin can create an actor linked to a chat', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Chat Test Actor',
          chat_id: chatId,
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Chat Test Actor');
      expect(response.body.chat_id).toBe(chatId);
    });

    test('lists actors filtered by chat_id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/actors?project_id=${projectId}&chat_id=${chatId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(
        response.body.data.every((a: { chat_id: string }) => {
          return a.chat_id === chatId;
        })
      ).toBe(true);
    });
  });
});
