import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Chats', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'chatsadmin', password: 'supersecret' });

    adminToken = await loginAs('chatsadmin', 'supersecret');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'chatsuser', password: 'chatspass' });

    userToken = await loginAs('chatsuser', 'chatspass');
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
          aiProviderId: 'aip_doesnotexist000000',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });
  });
});
