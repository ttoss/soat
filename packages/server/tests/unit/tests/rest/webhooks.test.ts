import { db } from 'src/db';

import { expectAdminListSpansProjects } from '../../fixtures/adminUnscopedList';
import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Webhooks', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  /** The user's own policy: the grant a webhook it creates may carry. */
  let userPolicyId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'webhooks',
      policyActions: [
        'webhooks:ListWebhooks',
        'webhooks:CreateWebhook',
        'webhooks:GetWebhook',
        'webhooks:GetWebhookSecret',
        'webhooks:UpdateWebhook',
        'webhooks:DeleteWebhook',
        'webhooks:RotateWebhookSecret',
        'webhooks:ListWebhookDeliveries',
        'webhooks:GetWebhookDelivery',
        'webhooks:RedeliverWebhookDelivery',
      ],
      createNoPermUser: false,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    userPolicyId = setup.policyId;
  });

  describe('POST /api/v1/webhooks', () => {
    test('authenticated user can create a webhook', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
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

    test.each([
      ['not-a-url'],
      ['ftp://hooks.example.com'],
      ['https://user:pass@hooks.example.com/hook'],
    ])('returns 400 for url %s', async (url) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
          name: 'Bad URL Webhook',
          url,
          events: ['files.created'],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
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
        policy_ids: [userPolicyId],
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
          policy_ids: [userPolicyId],
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
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/webhooks?project_id=${projectId}`
      );

      expect(response.status).toBe(401);
    });

    test('an admin without project_id lists every project', async () => {
      await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
          name: 'Admin Listed',
          url: 'https://example.com/admin-listed',
          events: ['*'],
        });
      await expectAdminListSpansProjects({
        adminToken,
        path: '/api/v1/webhooks',
        projectId,
      });
    });
  });

  describe('GET /api/v1/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
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
          policy_ids: [userPolicyId],
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

    test('the secret is stored encrypted at rest, not in plaintext', async () => {
      const apiResponse = await authenticatedTestClient(userToken).get(
        `/api/v1/webhooks/${webhookId}/secret`
      );
      const plaintextSecret = apiResponse.body.secret as string;

      const row = await db.Webhook.findOne({
        where: { publicId: webhookId },
      });

      expect(row!.secret).not.toBe(plaintextSecret);
    });

    // See the matching trigger case: the pre-encryption plaintext fallback is
    // gone, so a legacy row is refused with a named, actionable error.
    test('a legacy plaintext row (pre-encryption) is refused, naming the remedy', async () => {
      const row = await db.Webhook.findOne({
        where: { publicId: webhookId },
      });
      const legacyPlaintextSecret = 'a'.repeat(64);
      await row!.update({ secret: legacyPlaintextSecret });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhooks/${webhookId}/secret`
      );

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('SECRET_NOT_DECRYPTABLE');
      expect(response.body.error.message).toMatch(/rotate/i);
      expect(JSON.stringify(response.body)).not.toContain(
        legacyPlaintextSecret
      );
    });
  });

  describe('PUT /api/v1/webhooks/:webhookId', () => {
    let webhookId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
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
          policy_ids: [userPolicyId],
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

      const row = await db.Webhook.findOne({
        where: { publicId: webhookId },
      });
      expect(row!.secret).not.toBe(response.body.secret);
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
          policy_ids: [userPolicyId],
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
      expect(response.body).toHaveProperty('next_cursor');
    });

    test('pages with limit and cursor', async () => {
      const webhook = await db.Webhook.findOne({
        where: { publicId: webhookId },
      });
      for (const eventType of ['files.created', 'files.deleted']) {
        await db.WebhookDelivery.create({
          webhookId: webhook!.id as number,
          eventType,
          payload: {},
          status: 'completed',
          statusCode: 200,
          attempts: 1,
        });
      }

      const first = await authenticatedTestClient(userToken).get(
        `/api/v1/webhook-deliveries?webhook_id=${webhookId}&limit=1`
      );
      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(1);
      expect(typeof first.body.next_cursor).toBe('string');

      const second = await authenticatedTestClient(userToken).get(
        `/api/v1/webhook-deliveries?webhook_id=${webhookId}&limit=1&cursor=${first.body.next_cursor}`
      );
      expect(second.status).toBe(200);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    });

    test('lists a delivery with its mapped fields', async () => {
      const webhook = await db.Webhook.findOne({
        where: { publicId: webhookId },
      });
      const delivery = await db.WebhookDelivery.create({
        webhookId: webhook!.id as number,
        eventType: 'files.created',
        payload: { hello: 'world' },
        status: 'completed',
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
        status: 'completed',
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
    test('authenticated user with permission can get a delivery by id', async () => {
      const hookRes = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
          name: 'Get Delivery Test',
          url: 'https://example.com/get-delivery',
          events: ['*'],
        });
      const webhook = await db.Webhook.findOne({
        where: { publicId: hookRes.body.id },
      });
      const delivery = await db.WebhookDelivery.create({
        webhookId: webhook!.id as number,
        eventType: 'files.created',
        payload: {},
        status: 'completed',
        statusCode: 200,
        attempts: 1,
      });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/webhook-deliveries/${delivery.publicId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(delivery.publicId);
    });

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

  describe('POST /api/v1/webhook-deliveries/:deliveryId/redeliver', () => {
    const createFailedDelivery = async (args: {
      name: string;
      url: string;
    }) => {
      const hookRes = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
          name: args.name,
          url: args.url,
          events: ['files.created'],
        });
      const webhook = await db.Webhook.findOne({
        where: { publicId: hookRes.body.id },
      });
      const delivery = await db.WebhookDelivery.create({
        webhookId: webhook!.id as number,
        eventType: 'files.created',
        payload: { event: 'files.created', resource_id: 'fil_redeliver' },
        status: 'failed',
        statusCode: 502,
        attempts: 3,
      });
      return { delivery, webhookPublicId: hookRes.body.id as string };
    };

    test('queues a fresh delivery and answers 202 with a handle to poll', async () => {
      const { delivery, webhookPublicId } = await createFailedDelivery({
        name: 'Redeliver Test',
        url: 'https://example.com/redeliver',
      });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/webhook-deliveries/${delivery.publicId}/redeliver`
      );

      expect(response.status).toBe(202);
      // A redelivery is a new attempt record, not a mutation of the original —
      // the failed delivery stays in the history a subscriber can audit.
      expect(response.body.id).toBeDefined();
      expect(response.body.id).not.toBe(delivery.publicId);
      expect(response.body.webhook_id).toBe(webhookPublicId);
      expect(response.body.status).toBe('queued');
      expect(response.body.attempts).toBe(0);
      expect(response.body.event_type).toBe('files.created');
      expect(response.body.payload).toEqual({
        event: 'files.created',
        resource_id: 'fil_redeliver',
      });
      // It is due immediately, so the outbox sweep picks it up on its next tick.
      expect(response.body.next_attempt_at).toBeDefined();

      await delivery.reload();
      expect(delivery.status).toBe('failed');
      expect(delivery.attempts).toBe(3);
    });

    test('returns 404 for a non-existent delivery', async () => {
      const response = await authenticatedTestClient(userToken).post(
        '/api/v1/webhook-deliveries/wdh_nonexistent/redeliver'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        '/api/v1/webhook-deliveries/wdh_nonexistent/redeliver'
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
          policy_ids: [userPolicyId],
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

  describe('policy_ids and the event filter', () => {
    const create = (body: Record<string, unknown>) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Filtered',
          url: 'https://example.com/filtered',
          events: ['files.*'],
          policy_ids: [userPolicyId],
          ...body,
        });
    };

    test('create stores and returns policy_ids, event_resources and event_data', async () => {
      const response = await create({
        event_resources: [`srn:${projectId}:file:*`],
        event_data: { filename: { in: ['a.txt', 'b.txt'] } },
      });

      expect(response.status).toBe(201);
      expect(response.body.policy_ids).toEqual([userPolicyId]);
      expect(response.body.event_resources).toEqual([
        `srn:${projectId}:file:*`,
      ]);
      expect(response.body.event_data).toEqual({
        filename: { in: ['a.txt', 'b.txt'] },
      });
      expect(response.body).not.toHaveProperty('policy_id');
    });

    test('create without event_resources or event_data reads them back null', async () => {
      const response = await create({});

      expect(response.status).toBe(201);
      expect(response.body.event_resources).toBeNull();
      expect(response.body.event_data).toBeNull();
    });

    test.each([
      ['missing', { policy_ids: undefined }],
      ['empty', { policy_ids: [] }],
    ])('create with policy_ids %s returns 400', async (_label, body) => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('create with the retired policy_id returns 400', async () => {
      const response = await create({ policy_id: userPolicyId });

      expect(response.status).toBe(400);
    });

    test('create attaching a policy the caller does not hold returns 403', async () => {
      const wider = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: { statement: [{ effect: 'Allow', action: ['*'] }] },
        });
      expect(wider.status).toBe(201);

      const response = await create({ policy_ids: [wider.body.id] });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });

    test('create with a misspelt platform event returns 400', async () => {
      const response = await create({ events: ['files.creatd'] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_EVENT_PATTERN');
    });

    test.each([
      ['event_resources', { event_resources: ['file:*'] }],
      ['event_data', { event_data: { size: { gt: true } } }],
    ])('create with an invalid %s returns 400', async (_label, body) => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('update replaces the filter, and null clears event_resources and event_data', async () => {
      const created = await create({
        event_resources: [`srn:${projectId}:file:*`],
        event_data: { filename: 'a.txt' },
      });
      expect(created.status).toBe(201);

      const narrowed = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ events: ['files.created'], event_data: { filename: 'b.txt' } });
      expect(narrowed.status).toBe(200);
      expect(narrowed.body.events).toEqual(['files.created']);
      expect(narrowed.body.event_data).toEqual({ filename: 'b.txt' });
      expect(narrowed.body.event_resources).toEqual([
        `srn:${projectId}:file:*`,
      ]);

      const cleared = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ event_resources: null, event_data: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.event_resources).toBeNull();
      expect(cleared.body.event_data).toBeNull();
    });

    test('update with an invalid filter or empty policy_ids returns 400', async () => {
      const created = await create({});
      expect(created.status).toBe(201);

      for (const body of [
        { events: ['documents.ingsted'] },
        { event_resources: ['*:*'] },
        { policy_ids: [] },
      ]) {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/webhooks/${created.body.id}`)
          .send(body);
        expect(response.status).toBe(400);
      }
    });

    test('update attaching a policy the caller does not hold returns 403', async () => {
      const created = await create({});
      const wider = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: { statement: [{ effect: 'Allow', action: ['*'] }] },
        });

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ policy_ids: [userPolicyId, wider.body.id] });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });

    test('a policy a webhook names cannot be deleted', async () => {
      const policy = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'Carrier',
          url: 'https://example.com/carrier',
          events: ['files.*'],
          policy_ids: [policy.body.id],
        });
      expect(created.status).toBe(201);

      const response = await authenticatedTestClient(adminToken).delete(
        `/api/v1/policies/${policy.body.id}`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('POLICY_HAS_DEPENDENTS');
      expect(response.body.error.meta).toMatchObject({
        webhooks: 1,
        webhook_sample: [created.body.id],
      });
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
          policy_ids: [userPolicyId],
          name: 'Branch Target',
          url: 'https://example.com/branch',
          events: ['*'],
        });
      targetWebhookId = hookRes.body.id;
    });

    test('POST /webhooks with an empty events array returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
          name: 'No events',
          url: 'https://example.com/hook',
          events: [],
        });

      expect(response.status).toBe(400);
    });

    test('POST /webhooks naming a policy that does not exist returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: ['pol_nonexistent'],
          name: 'Bad policy',
          url: 'https://example.com/hook',
          events: ['*'],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('POLICY_NOT_FOUND');
    });

    test('GET /webhooks without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/webhooks')
        .query({ project_id: projectId });

      expect(response.status).toBe(403);
    });

    test('GET /webhooks/:id without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/webhooks/${targetWebhookId}`
      );

      expect(response.status).toBe(404);
    });

    test('PUT /webhooks/:id returns 404 for a non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/webhooks/wh_nonexistent')
        .send({ name: 'Nope' });

      expect(response.status).toBe(404);
    });

    test('PUT /webhooks/:id without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/webhooks/${targetWebhookId}`)
        .send({ name: 'Renamed' });

      expect(response.status).toBe(404);
    });

    test('PUT /webhooks/:id naming a policy that does not exist returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${targetWebhookId}`)
        .send({ policy_ids: ['pol_nonexistent'] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('POLICY_NOT_FOUND');
    });

    test('DELETE /webhooks/:id returns 404 for a non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/webhooks/wh_nonexistent'
      );

      expect(response.status).toBe(404);
    });

    test('DELETE /webhooks/:id without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/webhooks/${targetWebhookId}`
      );

      expect(response.status).toBe(404);
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
        .query({ webhook_id: 'wh_nonexistent' });

      expect(response.status).toBe(404);
    });

    test('GET /webhook-deliveries without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/webhook-deliveries')
        .query({ webhook_id: targetWebhookId });

      expect(response.status).toBe(404);
    });

    test('GET /webhook-deliveries/:deliveryId without permission returns 404', async () => {
      const webhook = await db.Webhook.findOne({
        where: { publicId: targetWebhookId },
      });
      const delivery = await db.WebhookDelivery.create({
        webhookId: webhook!.id as number,
        eventType: 'files.created',
        payload: {},
        status: 'completed',
        statusCode: 200,
        attempts: 1,
      });

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/webhook-deliveries/${delivery.publicId}`
      );

      expect(response.status).toBe(404);
    });

    test('POST /webhook-deliveries/:deliveryId/redeliver without permission returns 404', async () => {
      const webhook = await db.Webhook.findOne({
        where: { publicId: targetWebhookId },
      });
      const delivery = await db.WebhookDelivery.create({
        webhookId: webhook!.id as number,
        eventType: 'files.created',
        payload: {},
        status: 'failed',
        statusCode: 502,
        attempts: 3,
      });

      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/webhook-deliveries/${delivery.publicId}/redeliver`
      );

      expect(response.status).toBe(404);
    });

    test('POST /webhooks/:id/rotate-secret returns 404 for a non-existent webhook', async () => {
      const response = await authenticatedTestClient(userToken).post(
        '/api/v1/webhooks/wh_nonexistent/rotate-secret'
      );

      expect(response.status).toBe(404);
    });

    test('POST /webhooks/:id/rotate-secret without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/webhooks/${targetWebhookId}/rotate-secret`
      );

      expect(response.status).toBe(404);
    });
  });

  // A project-scoped credential (project key / OAuth token) carries a policy
  // whose resources are SRN-scoped to the project, not the wildcard `*`. The
  // by-id handlers must authorize against a project SRN — not the implicit `*`
  // default — or such a principal can list but never get/update/delete/rotate.
  describe('SRN-scoped principal (project-scoped credential)', () => {
    let scopedToken: string;

    beforeAll(async () => {
      scopedToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'webhooksscoped',
        actions: [
          'webhooks:GetWebhook',
          'webhooks:UpdateWebhook',
          'webhooks:DeleteWebhook',
          'webhooks:GetWebhookSecret',
          'webhooks:RotateWebhookSecret',
        ],
      });
    });

    test('can get, update, rotate-secret, and delete webhooks', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          policy_ids: [userPolicyId],
          name: 'Scoped Hook',
          url: 'https://example.com/scoped',
          events: ['*'],
        });
      const id = created.body.id;

      const getRes = await authenticatedTestClient(scopedToken).get(
        `/api/v1/webhooks/${id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(id);

      const secretRes = await authenticatedTestClient(scopedToken).get(
        `/api/v1/webhooks/${id}/secret`
      );
      expect(secretRes.status).toBe(200);

      const putRes = await authenticatedTestClient(scopedToken)
        .put(`/api/v1/webhooks/${id}`)
        .send({ name: 'Renamed' });
      expect(putRes.status).toBe(200);

      const rotateRes = await authenticatedTestClient(scopedToken).post(
        `/api/v1/webhooks/${id}/rotate-secret`
      );
      expect(rotateRes.status).toBe(200);

      const delRes = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/webhooks/${id}`
      );
      expect(delRes.status).toBe(204);
    });
  });
});
