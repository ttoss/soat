import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A webhook delivers an event only when its `policy_ids` read the event's
 * resource, so a write leaving it subscribed to events it cannot read is
 * refused naming each missing read.
 */
describe('Webhook reads its events', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let readsNothingId: string;
  let readsMemoriesId: string;
  let readsOneMemoryId: string;
  let seq = 0;

  const createPolicy = async (
    statement: Record<string, unknown>[]
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement } });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createWebhook = (args: {
    policyId: string;
    fields: Record<string, unknown>;
  }) => {
    seq += 1;
    return authenticatedTestClient(userToken)
      .post('/api/v1/webhooks')
      .send({
        project_id: projectId,
        name: `whreads-${seq}`,
        url: 'https://example.com/hook',
        policy_ids: [args.policyId],
        ...args.fields,
      });
  };

  const unreadOf = (body: {
    error: { meta?: { unread?: { namespace: string }[] } };
  }): string[] => {
    return (body.error.meta?.unread ?? [])
      .map((entry) => {
        return entry.namespace;
      })
      .sort();
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'whreads',
      policyActions: [
        'webhooks:CreateWebhook',
        'webhooks:GetWebhook',
        'webhooks:UpdateWebhook',
        'memories:GetMemory',
        'documents:GetDocument',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    readsNothingId = await createPolicy([
      { effect: 'Allow', action: ['webhooks:GetWebhook'] },
    ]);
    readsMemoriesId = await createPolicy([
      { effect: 'Allow', action: ['memories:GetMemory'] },
    ]);
    readsOneMemoryId = await createPolicy([
      {
        effect: 'Allow',
        action: ['memories:GetMemory'],
        resource: [`srn:${projectId}:memory:mem_one`],
      },
    ]);
  });

  describe('POST /api/v1/webhooks', () => {
    test('refuses events its policies cannot read, naming each missing read (400)', async () => {
      const res = await createWebhook({
        policyId: readsNothingId,
        fields: { events: ['memories.*'] },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EVENTS_UNREADABLE');
      expect(res.body.error.meta.unread).toEqual([
        {
          namespace: 'memories',
          action: 'memories:GetMemory',
          resource: `srn:${projectId}:memory:*`,
        },
      ]);
    });

    test('accepts events its policies read', async () => {
      const res = await createWebhook({
        policyId: readsMemoriesId,
        fields: { events: ['memories.created', 'memories.updated'] },
      });

      expect(res.status).toBe(201);
    });

    test('names only the namespaces left unread', async () => {
      const res = await createWebhook({
        policyId: readsMemoriesId,
        fields: { events: ['memories.created', 'documents.*'] },
      });

      expect(res.status).toBe(400);
      expect(unreadOf(res.body)).toEqual(['documents']);
    });

    test('`*` needs a read on every registered namespace', async () => {
      const res = await createWebhook({
        policyId: readsMemoriesId,
        fields: { events: ['*'] },
      });

      expect(res.status).toBe(400);
      const unread = unreadOf(res.body);
      expect(unread).toContain('documents');
      expect(unread).toContain('agents');
      expect(unread).not.toContain('memories');
    });

    test('a read of one resource covers event_resources naming only it', async () => {
      const wide = await createWebhook({
        policyId: readsOneMemoryId,
        fields: { events: ['memories.*'] },
      });
      expect(wide.status).toBe(400);
      expect(wide.body.error.code).toBe('EVENTS_UNREADABLE');

      const narrowed = await createWebhook({
        policyId: readsOneMemoryId,
        fields: {
          events: ['memories.*'],
          event_resources: [`srn:${projectId}:memory:mem_one`],
        },
      });
      expect(narrowed.status).toBe(201);
    });

    test('an author-authored event outside every platform namespace is not checked', async () => {
      const res = await createWebhook({
        policyId: readsNothingId,
        fields: { events: ['orders.shipped'] },
      });

      expect(res.status).toBe(201);
    });
  });

  describe('PUT /api/v1/webhooks/:id', () => {
    test('refuses an update leaving the webhook unable to read its events (400)', async () => {
      const created = await createWebhook({
        policyId: readsMemoriesId,
        fields: { events: ['memories.*'] },
      });
      expect(created.status).toBe(201);

      const narrowed = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ policy_ids: [readsNothingId] });
      expect(narrowed.status).toBe(400);
      expect(narrowed.body.error.code).toBe('EVENTS_UNREADABLE');
      expect(unreadOf(narrowed.body)).toEqual(['memories']);

      const widened = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ events: ['documents.*'] });
      expect(widened.status).toBe(400);
      expect(unreadOf(widened.body)).toEqual(['documents']);

      const resourceWidened = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ policy_ids: [readsOneMemoryId] });
      expect(resourceWidened.status).toBe(400);

      const stored = await authenticatedTestClient(userToken).get(
        `/api/v1/webhooks/${created.body.id}`
      );
      expect(stored.body.policy_ids).toEqual([readsMemoriesId]);
      expect(stored.body.events).toEqual(['memories.*']);
    });

    test('accepts an update its policies still read', async () => {
      const created = await createWebhook({
        policyId: readsOneMemoryId,
        fields: {
          events: ['memories.created'],
          event_resources: [`srn:${projectId}:memory:mem_one`],
        },
      });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/webhooks/${created.body.id}`)
        .send({ events: ['memories.*'] });

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual(['memories.*']);
    });
  });
});
