import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('POST /api/v1/users/bootstrap', () => {
  test('should create the first admin user and return 201', async () => {
    const response = await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.username).toBe('admin');
    expect(response.body.role).toBe('admin');
    expect(response.body.password).toBeUndefined();
  });

  test('should return 409 if a user already exists', async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    const response = await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin2', password: 'anotherpassword' });

    expect(response.status).toBe(409);
  });
});

describe('POST /api/v1/users/login', () => {
  test('should return token and user data on valid credentials', async () => {
    const response = await testClient
      .post('/api/v1/users/login')
      .send({ username: 'admin', password: 'supersecret' });

    expect(response.status).toBe(200);
    expect(response.body.token).toBeDefined();
    expect(response.body.username).toBe('admin');
    expect(response.body.role).toBe('admin');
    expect(response.body.password).toBeUndefined();
  });

  test('should return 401 on invalid credentials', async () => {
    const response = await testClient
      .post('/api/v1/users/login')
      .send({ username: 'admin', password: 'wrongpassword' });

    expect(response.status).toBe(401);
  });
});

describe('Admin user operations', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await loginAs('admin', 'supersecret');
  });

  describe('POST /api/v1/users', () => {
    test('admin can create a regular user', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'alice', password: 'alicepass', role: 'user' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.username).toBe('alice');
      expect(response.body.role).toBe('user');
      expect(response.body.password).toBeUndefined();
    });

    test('admin can create another admin', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'admin2', password: 'admin2pass', role: 'admin' });

      expect(response.status).toBe(201);
      expect(response.body.username).toBe('admin2');
      expect(response.body.role).toBe('admin');
    });

    test('unauthenticated request cannot create a user', async () => {
      const response = await testClient
        .post('/api/v1/users')
        .send({ username: 'hacker', password: 'pass' });

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot create a user', async () => {
      const aliceToken = await loginAs('alice', 'alicepass');
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/users')
        .send({ username: 'bob', password: 'bobpass' });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/users', () => {
    test('admin can list users', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/users');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(
        response.body.some((u: { username: string }) => {
          return u.username === 'admin';
        })
      ).toBe(true);
    });

    test('unauthenticated request cannot list users', async () => {
      const response = await testClient.get('/api/v1/users');

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot list users', async () => {
      const aliceToken = await loginAs('alice', 'alicepass');
      const response =
        await authenticatedTestClient(aliceToken).get('/api/v1/users');

      expect(response.status).toBe(403);
    });

    test('second admin can also list users', async () => {
      const admin2Token = await loginAs('admin2', 'admin2pass');
      const response =
        await authenticatedTestClient(admin2Token).get('/api/v1/users');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('GET /api/v1/users/:id', () => {
    test('admin can get a user by id', async () => {
      const listRes =
        await authenticatedTestClient(adminToken).get('/api/v1/users');
      const alice = listRes.body.find((u: { username: string }) => {
        return u.username === 'alice';
      });

      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/users/${alice.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.username).toBe('alice');
    });

    test('should return 404 for unknown user id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/users/usr_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request cannot get a user', async () => {
      const listRes =
        await authenticatedTestClient(adminToken).get('/api/v1/users');
      const alice = listRes.body.find((u: { username: string }) => {
        return u.username === 'alice';
      });

      const response = await testClient.get(`/api/v1/users/${alice.id}`);

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot get another user', async () => {
      const aliceToken = await loginAs('alice', 'alicepass');
      const listRes =
        await authenticatedTestClient(adminToken).get('/api/v1/users');
      const admin = listRes.body.find((u: { username: string }) => {
        return u.username === 'admin';
      });

      const response = await authenticatedTestClient(aliceToken).get(
        `/api/v1/users/${admin.id}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/users/:id', () => {
    test('admin can delete a user', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'todelete', password: 'pass' });
      const { id } = createRes.body;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/users/${id}`
      );
      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/users/${id}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request cannot delete a user', async () => {
      const listRes =
        await authenticatedTestClient(adminToken).get('/api/v1/users');
      const alice = listRes.body.find((u: { username: string }) => {
        return u.username === 'alice';
      });

      const response = await testClient.delete(`/api/v1/users/${alice.id}`);

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot delete a user', async () => {
      const aliceToken = await loginAs('alice', 'alicepass');
      const listRes =
        await authenticatedTestClient(adminToken).get('/api/v1/users');
      const admin = listRes.body.find((u: { username: string }) => {
        return u.username === 'admin';
      });

      const response = await authenticatedTestClient(aliceToken).delete(
        `/api/v1/users/${admin.id}`
      );

      expect(response.status).toBe(403);
    });

    test('second admin can also delete a user', async () => {
      const admin2Token = await loginAs('admin2', 'admin2pass');
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'todelete2', password: 'pass' });
      const { id } = createRes.body;

      const response = await authenticatedTestClient(admin2Token).delete(
        `/api/v1/users/${id}`
      );

      expect(response.status).toBe(204);
    });
  });
});
