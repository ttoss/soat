import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('POST /api/v1/projects', () => {
  let adminToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');
  });

  test('admin can create a project', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'My Project' });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.name).toBe('My Project');
    expect(response.body.createdAt).toBeDefined();
    expect(response.body.updatedAt).toBeDefined();
  });
});
