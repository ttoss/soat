import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('AI Providers', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;
  let secretId: string;
  let noPermToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'aiprovadmin', password: 'supersecret' });

    adminToken = await loginAs('aiprovadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'aiprovuser', password: 'aiprovpass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('aiprovuser', 'aiprovpass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'AI Providers Test Project' });
    projectId = projectRes.body.id;

    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'AI Providers Other Project' });
    otherProjectId = otherProjectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'aiProviders:ListAiProviders',
                'aiProviders:GetAiProvider',
                'aiProviders:CreateAiProvider',
                'aiProviders:UpdateAiProvider',
                'aiProviders:DeleteAiProvider',
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'aiprovnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('aiprovnoperm', 'nopassword');

    const secretRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({
        project_id: projectId,
        name: 'AI Provider Secret',
        value: 'sk-test',
      });
    secretId = secretRes.body.id;
  });

  describe('GET /api/v1/ai-providers', () => {
    test('authenticated user can list AI providers', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/ai-providers')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/ai-providers');
      expect(response.status).toBe(401);
    });

    test('user without access to project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/ai-providers')
        .query({ project_id: otherProjectId });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/ai-providers', () => {
    test('authenticated user with permission can create an AI provider', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'My OpenAI',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('My OpenAI');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.provider).toBe('openai');
      expect(response.body.default_model).toBe('gpt-4o');
      expect(response.body.secret_id).toBeNull();
    });

    test('can create AI provider linked to a secret', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          secret_id: secretId,
          name: 'My OpenAI With Key',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(201);
      expect(response.body.secret_id).toBe(secretId);
    });

    test('create without name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(400);
    });

    test('create with invalid provider returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'x',
          provider: 'invalid',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(400);
    });

    test('create without defaultModel returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({ project_id: projectId, name: 'x', provider: 'openai' });

      expect(response.status).toBe(400);
    });

    test('create with secretId from wrong project returns 400', async () => {
      const otherSecretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ project_id: otherProjectId, name: 'Other Project Secret' });
      const otherSecretId = otherSecretRes.body.id;

      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          secret_id: otherSecretId,
          name: 'x',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/ai-providers').send({
        project_id: projectId,
        name: 'x',
        provider: 'openai',
        default_model: 'gpt-4o',
      });

      expect(response.status).toBe(401);
    });

    test('user without permission on project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'x',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/ai-providers/:aiProviderId', () => {
    let aiProviderId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Get Test Provider',
          provider: 'anthropic',
          default_model: 'claude-3-5-haiku-latest',
        });
      aiProviderId = res.body.id;
    });

    test('authenticated user with permission can get an AI provider', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${aiProviderId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(aiProviderId);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.provider).toBe('anthropic');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'Other Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/ai-providers/${adminRes.body.id}`
      );
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/ai-providers/aip_doesnotexist'
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/ai-providers/:aiProviderId', () => {
    let aiProviderId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Patch Test Provider',
          provider: 'openai',
          default_model: 'gpt-4o-mini',
        });
      aiProviderId = res.body.id;
    });

    test('authenticated user with permission can update an AI provider', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${aiProviderId}`)
        .send({ name: 'Updated Provider', default_model: 'gpt-4o' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(aiProviderId);
      expect(response.body.name).toBe('Updated Provider');
      expect(response.body.default_model).toBe('gpt-4o');
    });

    test('can link a secret when updating', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${aiProviderId}`)
        .send({ secret_id: secretId });

      expect(response.status).toBe(200);
      expect(response.body.secret_id).toBe(secretId);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/ai-providers/${aiProviderId}`)
        .send({ name: 'x' });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'Other Patch Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/ai-providers/${adminRes.body.id}`)
        .send({ name: 'x' });
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/ai-providers/aip_doesnotexist')
        .send({ name: 'x' });
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/ai-providers/:aiProviderId', () => {
    test('authenticated user with permission can delete an AI provider', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'To Delete',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      const aiProviderId = createRes.body.id;

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(response.status).toBe(204);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        '/api/v1/ai-providers/aip_doesnotexist'
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'Other Delete Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/ai-providers/${adminRes.body.id}`
      );
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/ai-providers/aip_doesnotexist'
      );
      expect(response.status).toBe(404);
    });
  });
});
