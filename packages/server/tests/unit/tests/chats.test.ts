import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Chats', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;
  let aiProviderId: string;

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
      .post(`/api/v1/projects/${projectId}/policies`)
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
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userId, policy_id: policyId });

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
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('unknown aiProviderId returns 404', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: 'aip_doesnotexist000000', project_id: projectId });

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
      const response = await authenticatedTestClient(userToken)
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
  });
});
