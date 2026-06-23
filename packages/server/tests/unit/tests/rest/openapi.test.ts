import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('GET /api/v1/openapi.json', () => {
  let adminToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');
  });

  test('returns merged OpenAPI spec for authenticated user', async () => {
    const res = await authenticatedTestClient(adminToken).get(
      '/api/v1/openapi.json'
    );
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBeDefined();
    expect(typeof res.body.paths).toBe('object');
    expect(typeof res.body.components).toBe('object');
  });

  test('spec contains known paths', async () => {
    const res = await authenticatedTestClient(adminToken).get(
      '/api/v1/openapi.json'
    );
    expect(res.status).toBe(200);
    expect(res.body.paths['/api/v1/projects']).toBeDefined();
    expect(res.body.paths['/api/v1/users']).toBeDefined();
  });

  test('serves valid OpenAPI: camelCase structural keys, snake_case fields', async () => {
    const res = await authenticatedTestClient(adminToken).get(
      '/api/v1/openapi.json'
    );
    expect(res.status).toBe(200);

    // Structural OpenAPI vocabulary must stay camelCase — caseTransform must
    // NOT rewrite it to operation_id / request_body (which broke app forms).
    const createProject = res.body.paths['/api/v1/projects'].post;
    expect(createProject.operationId).toBe('createProject');
    expect(createProject.operation_id).toBeUndefined();
    expect(createProject.requestBody).toBeDefined();
    expect(createProject.request_body).toBeUndefined();

    // The API field names the spec describes remain snake_case as authored.
    const createKey = res.body.paths['/api/v1/api-keys'].post;
    const keyProps =
      createKey.requestBody.content['application/json'].schema.properties;
    expect(keyProps.project_id).toBeDefined();
    expect(keyProps.projectId).toBeUndefined();
  });

  test('returns 401 for unauthenticated request', async () => {
    const res = await testClient.get('/api/v1/openapi.json');
    expect(res.status).toBe(401);
  });
});
