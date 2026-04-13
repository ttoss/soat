import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Secrets', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;

  beforeAll(async () => {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.SECRETS_ENCRYPTION_KEY = '0'.repeat(64);

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'secretsadmin', password: 'supersecret' });

    adminToken = await loginAs('secretsadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'secretsuser', password: 'secretspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('secretsuser', 'secretspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Secrets Test Project' });
    projectId = projectRes.body.id;

    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Secrets Other Project' });
    otherProjectId = otherProjectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: [
          'secrets:ListSecrets',
          'secrets:GetSecret',
          'secrets:CreateSecret',
          'secrets:UpdateSecret',
          'secrets:DeleteSecret',
        ],
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId, policyId });
  });

  describe('GET /api/v1/secrets', () => {
    test('authenticated user can list secrets', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/secrets')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/secrets');
      expect(response.status).toBe(401);
    });

    test('user without access to project returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/secrets')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/secrets', () => {
    test('authenticated user with permission can create a secret', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({ projectId, name: 'Test Secret', value: 'supersecretvalue' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Test Secret');
      expect(response.body.projectId).toBe(projectId);
      expect(response.body.hasValue).toBe(true);
      // value must never be returned
      expect(response.body.value).toBeUndefined();
    });

    test('create without name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({ projectId });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/secrets')
        .send({ projectId, name: 'Test' });

      expect(response.status).toBe(401);
    });

    test('user without permission on project returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({ projectId: otherProjectId, name: 'Test' });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/secrets/:secretId', () => {
    let secretId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId, name: 'Get Test Secret' });
      secretId = res.body.id;
    });

    test('authenticated user with permission can get a secret', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/secrets/${secretId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(secretId);
      expect(response.body.projectId).toBe(projectId);
      expect(response.body.value).toBeUndefined();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/secrets/${secretId}`);
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      // Create a secret in otherProject (as admin) and try to access it as user
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId: otherProjectId, name: 'Other Secret' });
      const otherId = adminRes.body.id;

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/secrets/${otherId}`
      );
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/secrets/sec_doesnotexist'
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/secrets/:secretId', () => {
    let secretId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId, name: 'Patch Test Secret' });
      secretId = res.body.id;
    });

    test('authenticated user with permission can update a secret', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/secrets/${secretId}`)
        .send({ name: 'Updated Name', value: 'newvalue' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(secretId);
      expect(response.body.name).toBe('Updated Name');
      expect(response.body.hasValue).toBe(true);
      expect(response.body.value).toBeUndefined();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/secrets/${secretId}`)
        .send({ name: 'x' });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId: otherProjectId, name: 'Other Patch Secret' });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/secrets/${adminRes.body.id}`)
        .send({ name: 'x' });
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/secrets/sec_doesnotexist')
        .send({ name: 'x' });
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/secrets/:secretId', () => {
    test('authenticated user with permission can delete a secret', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId, name: 'To Delete' });
      const secretId = createRes.body.id;

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/secrets/${secretId}`
      );
      expect(response.status).toBe(204);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        '/api/v1/secrets/sec_doesnotexist'
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId: otherProjectId, name: 'Other Delete Secret' });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/secrets/${adminRes.body.id}`
      );
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/secrets/sec_doesnotexist'
      );
      expect(response.status).toBe(404);
    });

    test('secret referenced by AI provider returns 409 without force', async () => {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      process.env.SECRETS_ENCRYPTION_KEY = '0'.repeat(64);

      const secretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId, name: 'Linked Secret' });
      const linkedSecretId = secretRes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          projectId,
          secretId: linkedSecretId,
          name: 'Test Provider',
          provider: 'openai',
          defaultModel: 'gpt-4o',
        });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/secrets/${linkedSecretId}`
      );
      expect(response.status).toBe(409);
    });

    test('secret referenced by AI provider deleted with force=true returns 204', async () => {
      const secretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ projectId, name: 'Force Delete Secret' });
      const linkedSecretId = secretRes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          projectId,
          secretId: linkedSecretId,
          name: 'Test Provider Force',
          provider: 'openai',
          defaultModel: 'gpt-4o',
        });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/secrets/${linkedSecretId}?force=true`
      );
      expect(response.status).toBe(204);
    });
  });
});
