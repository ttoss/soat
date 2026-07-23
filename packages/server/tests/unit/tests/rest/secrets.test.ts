import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Secrets', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'secrets',
      policyActions: [
        'secrets:ListSecrets',
        'secrets:GetSecret',
        'secrets:CreateSecret',
        'secrets:UpdateSecret',
        'secrets:DeleteSecret',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;
  });

  describe('GET /api/v1/secrets', () => {
    test('authenticated user can list secrets', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/secrets')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/secrets');
      expect(response.status).toBe(401);
    });

    test('user without access to project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/secrets')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/secrets', () => {
    test('authenticated user with permission can create a secret', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'Test Secret',
          value: 'supersecretvalue',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Test Secret');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.has_value).toBe(true);
      // value must never be returned
      expect(response.body.value).toBeUndefined();
    });

    test('create without name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
    });

    test('unknown body field returns 400 VALIDATION_FAILED', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'Strict Secret',
          value: 'v',
          rotate: true,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/rotate/);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'Test' });

      expect(response.status).toBe(401);
    });

    test('user without permission on project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/secrets')
        .send({
          project_id: otherProjectId,
          name: 'Test',
          value: 'secret-value',
        });

      expect(response.status).toBe(403);
    });

    test('create without value returns 400 VALIDATION_FAILED', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'No Value Secret' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/value/);
    });
  });

  describe('GET /api/v1/secrets/:secretId', () => {
    let secretId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'Get Test Secret',
          value: 'secret-value',
        });
      secretId = res.body.id;
    });

    test('authenticated user with permission can get a secret', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/secrets/${secretId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(secretId);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.name).toBe('Get Test Secret');
      // The get response exposes has_value/updated_at, never the decrypted value.
      expect(response.body.has_value).toBe(true);
      expect(response.body.updated_at).toBeDefined();
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
        .send({
          project_id: otherProjectId,
          name: 'Other Secret',
          value: 'secret-value',
        });
      const otherId = adminRes.body.id;

      const response = await authenticatedTestClient(noPermToken).get(
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
        .send({
          project_id: projectId,
          name: 'Patch Test Secret',
          value: 'secret-value',
        });
      secretId = res.body.id;
    });

    test('authenticated user with permission can update a secret', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/secrets/${secretId}`)
        .send({ name: 'Updated Name', value: 'newvalue' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(secretId);
      expect(response.body.name).toBe('Updated Name');
      expect(response.body.has_value).toBe(true);
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
        .send({
          project_id: otherProjectId,
          name: 'Other Patch Secret',
          value: 'secret-value',
        });

      const response = await authenticatedTestClient(noPermToken)
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
        .send({
          project_id: projectId,
          name: 'To Delete',
          value: 'secret-value',
        });
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
        .send({
          project_id: otherProjectId,
          name: 'Other Delete Secret',
          value: 'secret-value',
        });

      const response = await authenticatedTestClient(noPermToken).delete(
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
      const secretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'Linked Secret',
          value: 'secret-value',
        });
      const linkedSecretId = secretRes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          secret_id: linkedSecretId,
          name: 'Test Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/secrets/${linkedSecretId}`
      );
      expect(response.status).toBe(409);
    });

    test('secret referenced by AI provider deleted with force=true returns 204', async () => {
      const secretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'Force Delete Secret',
          value: 'secret-value',
        });
      const linkedSecretId = secretRes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          secret_id: linkedSecretId,
          name: 'Test Provider Force',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/secrets/${linkedSecretId}?force=true`
      );
      expect(response.status).toBe(204);
    });
  });

  // A project-scoped credential (project key / OAuth token) carries a policy
  // whose resources are SRN-scoped to the project, not the wildcard `*`. The
  // by-id handlers must authorize against a project SRN — not the implicit `*`
  // default — or such a principal can list but never get/update/delete.
  describe('SRN-scoped principal (project-scoped credential)', () => {
    let scopedToken: string;

    beforeAll(async () => {
      scopedToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'secretsscoped',
        actions: [
          'secrets:ListSecrets',
          'secrets:GetSecret',
          'secrets:UpdateSecret',
          'secrets:DeleteSecret',
        ],
      });
    });

    test('can get, update, and delete secrets in its project', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'Scoped', value: 'v1' });
      const id = created.body.id;

      const listRes = await authenticatedTestClient(scopedToken)
        .get('/api/v1/secrets')
        .query({ projectId });
      expect(listRes.status).toBe(200);

      const getRes = await authenticatedTestClient(scopedToken).get(
        `/api/v1/secrets/${id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(id);

      const patchRes = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/secrets/${id}`)
        .send({ value: 'v2' });
      expect(patchRes.status).toBe(200);

      const delRes = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/secrets/${id}`
      );
      expect(delRes.status).toBe(204);
    });
  });
});
