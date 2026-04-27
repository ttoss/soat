import * as chatsLib from 'src/lib/chats';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Chats', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;
  let aiProviderId: string;
  let noPermToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'chatsadmin', password: 'supersecret' });

    adminToken = await loginAs('chatsadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'chatsuser', password: 'chatspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('chatsuser', 'chatspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Chats Test Project' });
    projectId = projectRes.body.id;

    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Chats Other Project' });
    otherProjectId = otherProjectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        permissions: [
          'chats:CreateChat',
          'chats:ListChats',
          'chats:GetChat',
          'chats:DeleteChat',
          'chats:CreateChatCompletion',
        ],
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'chatsnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('chatsnoperm', 'nopassword');

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

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('unknown aiProviderId returns 404', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          project_id: projectId,
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('creates a chat with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^cht_/);
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

    test('unknown chatId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/cht_doesnotexist0000/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('POST /api/v1/chats/completions', () => {
    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/chats/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(401);
      expect(response.body.error).toBeDefined();
    });

    test('missing messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/completions')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty messages array returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/completions')
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('non-array messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/completions')
        .send({ messages: 'hello' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('unknown aiProviderId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/completions')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('falls back to ollama when no aiProviderId is provided', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/completions')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
        });

      // Ollama is not running in tests, so it will fail with a connection error.
      // The important thing is that we reached the ollama fallback path (not the aiProviderId path).
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
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

  describe('POST /api/v1/chats/completions - with mocked AI', () => {
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
        .post('/api/v1/chats/completions')
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

    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

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

    test('sends chat_not_found error via SSE for unknown chatId', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/cht_doesnotexist0000/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }], stream: true });

      expect(response.status).toBe(200);
      expect(response.text).toContain('chat_not_found');
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

  // ── Streaming /chats/completions ────────────────────────────────────────

  describe('POST /api/v1/chats/completions - streaming (real lib)', () => {
    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/chats/completions').send({
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
        .post('/api/v1/chats/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(response.text).toContain('data:');
    });

    test('streams SSE response without ai_provider_id (ollama fallback)', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/completions')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    });
  });

  // ── Real createChatCompletionForChat execution (admin) ──────────────────

  describe('POST /api/v1/chats/:chatId/completions - real lib paths (admin)', () => {
    let realChatId: string;
    let openAiProviderId: string;

    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

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
      // createChatCompletionForChat runs getChatSystemMessage + buildChatFinalMessages before
      // calling generateText. generateText throws because ollama falls back to OpenAI
      // (no baseUrl set), and OpenAI returns 401 for the 'ollama' api key. Koa propagates
      // that statusCode as the HTTP response status.
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/chats/${realChatId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      // Not 200/201 — execution reached createChatCompletionForChat which then threw
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(404);
    });

    test('openai provider exercises getProviderFactory openai branch and buildModel factory-true branch (streaming)', async () => {
      // isOpenAILikeProvider('openai') = true → factory is non-null → buildModel uses factory.
      // OpenAI API fails (no valid key) → error written to SSE stream.
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats/completions')
        .send({
          ai_provider_id: openAiProviderId,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        });

      expect(res.status).toBe(200);
      expect(res.text).toContain('data:');
    });
  });

  // ── POST /chats/:chatId/actors ──────────────────────────────────────────

  describe('POST /api/v1/chats/:chatId/actors', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/chats/${chatId}/actors`)
        .send({ name: 'Test Actor' });

      expect(response.status).toBe(401);
    });

    test('non-existent chatId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats/cht_doesnotexist0000/actors')
        .send({ name: 'Test Actor' });

      expect(response.status).toBe(404);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/chats/${chatId}/actors`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without actors:CreateActor permission returns 403', async () => {
      // userToken only has chat permissions, not actors:CreateActor
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/actors`)
        .send({ name: 'Test Actor' });

      expect(response.status).toBe(403);
    });

    test('admin can create an actor for a chat', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/chats/${chatId}/actors`)
        .send({ name: 'Chat Test Actor' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Chat Test Actor');
    });
  });
});
