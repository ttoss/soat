import { db } from 'src/db';

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
                'webhooks:GetWebhookSecret',
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

  describe('POST /api/v1/webhooks', () => {
    test('authenticated user can create a webhook', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
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
        .post('/api/v1/webhooks')
        .send({ project_id: projectId, name: 'No URL' });

      expect(response.status).toBe(400);
    });

    test('returns 400 when project_id is missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          name: 'Test',
          url: 'https://example.com/hook',
          events: ['*'],
        });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/webhooks').send({
        project_id: projectId,
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
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Test',
          url: 'https://example.com/hook',
          events: ['*'],
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/webhooks', () => {
    test('authenticated user can list webhooks filtered by project', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhooks?project_id=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/webhooks?project_id=${projectId}`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Get Test',
          url: 'https://example.com/get',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can get a webhook', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhooks/${webhookId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(webhookId);
      expect(response.body.name).toBe('Get Test');
      expect(response.body.secret).toBeUndefined();
    });

    test('returns 404 for non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/webhooks/nonexistent'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/webhooks/${webhookId}`);

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/webhooks/:webhookId/secret', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Secret Test',
          url: 'https://example.com/secret',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can get the webhook secret', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhooks/${webhookId}/secret`
      );

      expect(response.status).toBe(200);
      expect(response.body.secret).toBeDefined();
      expect(typeof response.body.secret).toBe('string');
    });

    test('returns 404 for non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/webhooks/nonexistent/secret'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/webhooks/${webhookId}/secret`
      );

      expect(response.status).toBe(401);
    });

    test('user without GetWebhookSecret permission returns 403', async () => {
      const noSecretPermUserRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'webhooksnosecrperm', password: 'pass123' });

      expect(noSecretPermUserRes.status).toBe(201);

      const noSecretPermToken = await loginAs('webhooksnosecrperm', 'pass123');

      const limitedPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['webhooks:GetWebhook'],
              },
            ],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${noSecretPermUserRes.body.id}/policies`)
        .send({ policy_ids: [limitedPolicyRes.body.id] });

      const response = await authenticatedTestClient(noSecretPermToken).get(
        `/api/v1/webhooks/${webhookId}/secret`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('PUT /api/v1/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Update Test',
          url: 'https://example.com/update',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can update a webhook', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${webhookId}`)
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
        .put(`/api/v1/webhooks/${webhookId}`)
        .send({ name: 'X' });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/v1/webhooks/:webhookId/rotate-secret', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Rotate Test',
          url: 'https://example.com/rotate',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can rotate secret', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/webhooks/${webhookId}/rotate-secret`
      );

      expect(response.status).toBe(200);
      expect(response.body.secret).toBeDefined();
      expect(response.body.id).toBe(webhookId);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/webhooks/${webhookId}/rotate-secret`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/webhook-deliveries', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Deliveries Test',
          url: 'https://example.com/deliveries',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can list deliveries', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhook-deliveries?webhook_id=${webhookId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.total).toBeDefined();
    });

    test('lists a delivery with its mapped fields', async () => {
      const webhook = await db.Webhook.findOne({
        where: { publicId: webhookId },
      });
      const delivery = await db.WebhookDelivery.create({
        webhookId: webhook!.id as number,
        eventType: 'files.created',
        payload: { hello: 'world' },
        status: 'success',
        statusCode: 200,
        attempts: 1,
      });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhook-deliveries?webhook_id=${webhookId}`
      );

      expect(response.status).toBe(200);
      const found = response.body.data.find((d: { id: string }) => {
        return d.id === delivery.publicId;
      });
      expect(found).toMatchObject({
        webhook_id: webhookId,
        event_type: 'files.created',
        payload: { hello: 'world' },
        status: 'success',
        status_code: 200,
        attempts: 1,
      });
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/webhook-deliveries?webhook_id=${webhookId}`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/webhook-deliveries/:deliveryId', () => {
    test('returns 404 for non-existent delivery', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhook-deliveries/wdh_nonexistent`
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/webhook-deliveries/wdh_nonexistent`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Delete Test',
          url: 'https://example.com/delete',
          events: ['*'],
        });
      webhookId = res.body.id;
    });

    test('authenticated user can delete a webhook', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/webhooks/${webhookId}`
      );

      expect(response.status).toBe(204);

      const getResponse = await authenticatedTestClient(userToken).get(
        `/api/v1/webhooks/${webhookId}`
      );
      expect(getResponse.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete('/api/v1/webhooks/someid');

      expect(response.status).toBe(401);
    });
  });

  describe('authorization and validation branches', () => {
    let noPermToken: string;
    let targetWebhookId: string;

    beforeAll(async () => {
      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'webhooksbranches', password: 'pass123' });
      expect(userRes.status).toBe(201);
      noPermToken = await loginAs('webhooksbranches', 'pass123');

      const hookRes = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Branch Target',
          url: 'https://example.com/branch',
          events: ['*'],
        });
      targetWebhookId = hookRes.body.id;
    });

    test('POST /webhooks with an invalid policy_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Bad policy',
          url: 'https://example.com/hook',
          events: ['*'],
          policy_id: 'pol_nonexistent',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('POLICY_NOT_FOUND');
    });

    test('GET /webhooks without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/webhooks')
        .query({ projectId });

      expect(response.status).toBe(403);
    });

    test('GET /webhooks/:id without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/webhooks/${targetWebhookId}`
      );

      expect(response.status).toBe(403);
    });

    test('PUT /webhooks/:id returns 404 for a non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/webhooks/wh_nonexistent')
        .send({ name: 'Nope' });

      expect(response.status).toBe(404);
    });

    test('PUT /webhooks/:id without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/webhooks/${targetWebhookId}`)
        .send({ name: 'Renamed' });

      expect(response.status).toBe(403);
    });

    test('PUT /webhooks/:id with an invalid policy_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${targetWebhookId}`)
        .send({ policy_id: 'pol_nonexistent' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('POLICY_NOT_FOUND');
    });

    test('DELETE /webhooks/:id returns 404 for a non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/webhooks/wh_nonexistent'
      );

      expect(response.status).toBe(404);
    });

    test('DELETE /webhooks/:id without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/webhooks/${targetWebhookId}`
      );

      expect(response.status).toBe(403);
    });

    test('GET /webhook-deliveries without webhook_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/webhook-deliveries'
      );

      expect(response.status).toBe(400);
    });

    test('GET /webhook-deliveries with a non-existent webhook returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/webhook-deliveries')
        .query({ webhookId: 'wh_nonexistent' });

      expect(response.status).toBe(404);
    });

    test('GET /webhook-deliveries without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/webhook-deliveries')
        .query({ webhookId: targetWebhookId });

      expect(response.status).toBe(403);
    });

    test('POST /webhooks/:id/rotate-secret returns 404 for a non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken).post(
        '/api/v1/webhooks/wh_nonexistent/rotate-secret'
      );

      expect(response.status).toBe(404);
    });

    test('POST /webhooks/:id/rotate-secret without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/webhooks/${targetWebhookId}/rotate-secret`
      );

      expect(response.status).toBe(403);
    });
  });
});
