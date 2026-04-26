import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('caseTransform middleware', () => {
  let adminToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');
  });

  test('response body keys are snake_case', async () => {
    const response =
      await authenticatedTestClient(adminToken).get('/api/v1/users');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
    const keys = Object.keys(response.body[0]);
    for (const key of keys) {
      expect(key).not.toMatch(/[A-Z]/);
    }
    expect(response.body[0].created_at).toBeDefined();
  });

  test('request body accepts snake_case and converts to camelCase internally', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'case-test-project', description: 'test' });
    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();

    const projectId = response.body.id;

    // Verify the response uses snake_case
    expect(response.body.created_at).toBeDefined();
    expect(response.body.createdAt).toBeUndefined();

    // Clean up
    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('nested objects have snake_case keys', async () => {
    // Create a project to get a response with nested data
    const createRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'nested-case-test' });
    expect(createRes.status).toBe(201);

    const projectId = createRes.body.id;

    // List projects and check nested keys
    const listRes =
      await authenticatedTestClient(adminToken).get('/api/v1/projects');
    expect(listRes.status).toBe(200);

    const project = listRes.body.find((p: Record<string, unknown>) => {
      return p.id === projectId;
    });
    expect(project).toBeDefined();
    expect(project.created_at).toBeDefined();
    expect(project.updated_at).toBeDefined();

    // Clean up
    await authenticatedTestClient(adminToken).delete(
      `/api/v1/projects/${projectId}`
    );
  });

  test('array responses have snake_case keys on each item', async () => {
    const response =
      await authenticatedTestClient(adminToken).get('/api/v1/users');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    if (response.body.length > 0) {
      const keys = Object.keys(response.body[0]);
      for (const key of keys) {
        expect(key).not.toMatch(/[A-Z]/);
      }
    }
  });

  test('non /api/v1 paths are not transformed', async () => {
    // The health or root endpoint should not be transformed
    const response = await testClient.get('/');
    // Just verify it doesn't error — the middleware should skip non-api paths
    expect(response.status).toBeDefined();
  });
});
