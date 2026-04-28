import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Webhooks', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'webhooksuser', password: 'webhookspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('webhooksuser', 'webhookspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Webhooks Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'webhooks:ListWebhooks',
                'webhooks:CreateWebhook',
                'webhooks:GetWebhook',
                'webhooks:UpdateWebhook',
                'webhooks:DeleteWebhook',
                'webhooks:RotateWebhookSecret',
                'webhooks:ListWebhookDeliveries',
                'webhooks:GetWebhookDelivery',
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });
  });

  describe('POST /api/v1/projects/:projectId/webhooks', () => {
    test('authenticated user can create a webhook', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Test Webhook',
          url: 'https://example.com/hook',
          events: ['file.created', 'file.*'],
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Test Webhook');
      expect(response.body.url).toBe('https://example.com/hook');
      expect(response.body.events).toEqual(['file.created', 'file.*']);
      expect(response.body.active).toBe(true);
      expect(response.body.secret).toBeDefined();
      expect(response.body.project_id).toBe(projectId);
    });

    test('returns 400 when required fields are missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({ name: 'No URL' });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Test',
          url: 'https://example.com/hook',
          events: ['*'],
        });

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const noPermUserRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'webhooksnoperm', password: 'pass123' });

      expect(noPermUserRes.status).toBe(201);

      const noPermToken = await loginAs('webhooksnoperm', 'pass123');

      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Test',
          url: 'https://example.com/hook',
          events: ['*'],
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/projects/:projectId/webhooks', () => {
    test('authenticated user can list webhooks', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}/webhooks`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/projects/${projectId}/webhooks`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/projects/:projectId/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Get Test',
          url: 'https://example.com/get',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can get a webhook', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(webhookId);
      expect(response.body.name).toBe('Get Test');
      expect(response.body.secret).toBeUndefined();
    });

    test('returns 404 for non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}/webhooks/nonexistent`
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('PUT /api/v1/projects/:projectId/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Update Test',
          url: 'https://example.com/update',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can update a webhook', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/projects/${projectId}/webhooks/${webhookId}`)
        .send({
          name: 'Updated Name',
          active: false,
          events: ['file.*'],
        });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated Name');
      expect(response.body.active).toBe(false);
      expect(response.body.events).toEqual(['file.*']);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/projects/${projectId}/webhooks/${webhookId}`)
        .send({ name: 'X' });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/v1/projects/:projectId/webhooks/:webhookId/rotate-secret', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Rotate Test',
          url: 'https://example.com/rotate',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can rotate secret', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}/rotate-secret`
      );

      expect(response.status).toBe(200);
      expect(response.body.secret).toBeDefined();
      expect(response.body.id).toBe(webhookId);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}/rotate-secret`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/projects/:projectId/webhooks/:webhookId/deliveries', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Deliveries Test',
          url: 'https://example.com/deliveries',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can list deliveries', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.total).toBeDefined();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/projects/:projectId/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/webhooks`)
        .send({
          name: 'Delete Test',
          url: 'https://example.com/delete',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can delete a webhook', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}`
      );

      expect(response.status).toBe(204);

      const getResponse = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}/webhooks/${webhookId}`
      );
      expect(getResponse.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        `/api/v1/projects/${projectId}/webhooks/someid`
      );

      expect(response.status).toBe(401);
    });
  });
});
