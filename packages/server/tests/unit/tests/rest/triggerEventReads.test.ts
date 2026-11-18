import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * An event trigger receives an event only when its `policy_ids` read the
 * event's resource, so a write leaving it subscribed to events it cannot read
 * is refused naming each missing read.
 */
describe('Event trigger reads its events', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let orchestrationId: string;
  let startOnlyId: string;
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

  const createEventTrigger = (args: {
    policyId: string;
    fields: Record<string, unknown>;
  }) => {
    seq += 1;
    return authenticatedTestClient(userToken)
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: `trreads-${seq}`,
        type: 'event',
        target_type: 'orchestration',
        target_id: orchestrationId,
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
      prefix: 'trreads',
      policyActions: [
        'triggers:CreateTrigger',
        'triggers:GetTrigger',
        'triggers:UpdateTrigger',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'memories:GetMemory',
        'documents:GetDocument',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    orchestrationId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'trreads-orchestration',
          nodes: [{ id: 'noop', type: 'transform', expression: 42 }],
          edges: [],
        })
    ).body.id;

    startOnlyId = await createPolicy([
      { effect: 'Allow', action: ['orchestrations:StartRun'] },
    ]);
    readsMemoriesId = await createPolicy([
      {
        effect: 'Allow',
        action: ['orchestrations:StartRun', 'memories:GetMemory'],
      },
    ]);
    readsOneMemoryId = await createPolicy([
      { effect: 'Allow', action: ['orchestrations:StartRun'] },
      {
        effect: 'Allow',
        action: ['memories:GetMemory'],
        resource: [`srn:${projectId}:memory:mem_one`],
      },
    ]);
  });

  describe('POST /api/v1/triggers', () => {
    test('refuses events its policies cannot read, naming each missing read (400)', async () => {
      const res = await createEventTrigger({
        policyId: startOnlyId,
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
      const res = await createEventTrigger({
        policyId: readsMemoriesId,
        fields: { events: ['memories.created', 'memories.updated'] },
      });

      expect(res.status).toBe(201);
    });

    test('names only the namespaces left unread', async () => {
      const res = await createEventTrigger({
        policyId: readsMemoriesId,
        fields: { events: ['memories.created', 'documents.*'] },
      });

      expect(res.status).toBe(400);
      expect(unreadOf(res.body)).toEqual(['documents']);
    });

    test('`*` needs a read on every registered namespace', async () => {
      const res = await createEventTrigger({
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
      const wide = await createEventTrigger({
        policyId: readsOneMemoryId,
        fields: { events: ['memories.*'] },
      });
      expect(wide.status).toBe(400);
      expect(wide.body.error.code).toBe('EVENTS_UNREADABLE');

      const narrowed = await createEventTrigger({
        policyId: readsOneMemoryId,
        fields: {
          events: ['memories.*'],
          event_resources: [`srn:${projectId}:memory:mem_one`],
        },
      });
      expect(narrowed.status).toBe(201);
    });

    test('event_resources outside a namespace leave it unchecked', async () => {
      const res = await createEventTrigger({
        policyId: readsMemoriesId,
        fields: {
          events: ['memories.*', 'documents.*'],
          event_resources: [`srn:${projectId}:memory:*`],
        },
      });

      expect(res.status).toBe(201);
    });

    test('an author-authored event outside every platform namespace is not checked', async () => {
      const res = await createEventTrigger({
        policyId: startOnlyId,
        fields: { events: ['orders.shipped'] },
      });

      expect(res.status).toBe(201);
    });
  });

  describe('PATCH /api/v1/triggers/:id', () => {
    test('refuses an update leaving the trigger unable to read its events (400)', async () => {
      const created = await createEventTrigger({
        policyId: readsMemoriesId,
        fields: { events: ['memories.*'] },
      });
      expect(created.status).toBe(201);

      const narrowed = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ policy_ids: [startOnlyId] });
      expect(narrowed.status).toBe(400);
      expect(narrowed.body.error.code).toBe('EVENTS_UNREADABLE');
      expect(unreadOf(narrowed.body)).toEqual(['memories']);

      const widened = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ events: ['documents.*'] });
      expect(widened.status).toBe(400);
      expect(unreadOf(widened.body)).toEqual(['documents']);

      const stored = await authenticatedTestClient(userToken).get(
        `/api/v1/triggers/${created.body.id}`
      );
      expect(stored.body.policy_ids).toEqual([readsMemoriesId]);
      expect(stored.body.events).toEqual(['memories.*']);
    });

    test('accepts an update its policies still read', async () => {
      const created = await createEventTrigger({
        policyId: readsMemoriesId,
        fields: { events: ['memories.created'] },
      });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ events: ['memories.*'] });

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual(['memories.*']);
    });
  });
});
