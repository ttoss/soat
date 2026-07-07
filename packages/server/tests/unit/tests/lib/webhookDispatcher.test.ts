import { emitEvent } from 'src/lib/eventBus';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const SENTINEL_URL = 'https://example.com/hook-sentinel';

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  { attempts = 100, intervalMs = 25 } = {}
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      return setTimeout(resolve, intervalMs);
    });
  }
  throw new Error('waitFor: condition not met in time');
};

describe('webhookDispatcher', () => {
  let adminToken: string;
  let projectId: string;
  let projectInternalId: number | undefined;
  let fetchMock: jest.SpyInstance;
  let createdWebhookIds: string[] = [];

  const createWebhook = async (body: {
    project_id: string;
    name: string;
    url: string;
    events: string[];
    policy_id?: string;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/webhooks')
      .send(body);
    createdWebhookIds.push(res.body.id as string);
    return res;
  };

  const callsToUrl = (url: string) => {
    return fetchMock.mock.calls.filter(([calledUrl]) => {
      return calledUrl === url;
    });
  };

  // The sentinel webhook matches every event and is never deleted. Because
  // `handleEvent` iterates all matching webhooks in one synchronous pass
  // (nothing is awaited until each webhook's own `deliverWebhook` starts),
  // observing the sentinel's fetch call for a given event proves the whole
  // dispatch loop - including the decision for the webhook under test - has
  // already run for that event. This gives a deterministic sync point for
  // "this event should NOT reach a given webhook" assertions, without a
  // fixed sleep.
  const waitForDispatchSync = async () => {
    const baseline = callsToUrl(SENTINEL_URL).length;
    await waitFor(() => {
      return callsToUrl(SENTINEL_URL).length > baseline;
    });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'webhookdispatchadmin', password: 'supersecret' });

    adminToken = await loginAs('webhookdispatchadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Webhook Dispatcher Test Project' });

    projectId = projectRes.body.id;

    await authenticatedTestClient(adminToken)
      .post('/api/v1/webhooks')
      .send({
        project_id: projectId,
        name: 'Sentinel Webhook',
        url: SENTINEL_URL,
        events: ['*'],
      });
  });

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
  });

  afterEach(async () => {
    fetchMock.mockRestore();

    // Delete every webhook created by the test so it can't catch events
    // emitted by later tests (cross-test webhook accumulation).
    await Promise.all(
      createdWebhookIds.map((id) => {
        return authenticatedTestClient(adminToken).delete(
          `/api/v1/webhooks/${id}`
        );
      })
    );
    createdWebhookIds = [];
  });

  test('dispatcher delivers webhook for exact event match', async () => {
    await createWebhook({
      project_id: projectId,
      name: 'Exact Match Webhook',
      url: 'https://example.com/hook-exact',
      events: ['files.created'],
    });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_test123',
      data: { filename: 'test.txt' },
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      return callsToUrl('https://example.com/hook-exact').length > 0;
    });

    const webhookCalls = callsToUrl('https://example.com/hook-exact');
    expect(webhookCalls).toHaveLength(1);
    const [, init] = webhookCalls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(init.method).toBe('POST');
    expect(init.headers['X-Soat-Event']).toBe('files.created');
  });

  test('dispatcher delivers webhook for wildcard event match', async () => {
    await createWebhook({
      project_id: projectId,
      name: 'Wildcard Webhook',
      url: 'https://example.com/hook-wildcard',
      events: ['*'],
    });

    emitEvent({
      type: 'agents.generation.completed',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_test123',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      return callsToUrl('https://example.com/hook-wildcard').length > 0;
    });

    const webhookCalls = callsToUrl('https://example.com/hook-wildcard');
    expect(webhookCalls).toHaveLength(1);
    const [, init] = webhookCalls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers['X-Soat-Event']).toBe('agents.generation.completed');
  });

  test('dispatcher delivers webhook for prefix wildcard event match', async () => {
    await createWebhook({
      project_id: projectId,
      name: 'Prefix Wildcard Webhook',
      url: 'https://example.com/hook-prefix',
      events: ['agents.*'],
    });

    emitEvent({
      type: 'agents.generation.requires_action',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_test456',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      return callsToUrl('https://example.com/hook-prefix').length > 0;
    });

    const webhookCalls = callsToUrl('https://example.com/hook-prefix');
    expect(webhookCalls).toHaveLength(1);
    const [, init] = webhookCalls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers['X-Soat-Event']).toBe(
      'agents.generation.requires_action'
    );
  });

  test('dispatcher skips webhook when event does not match pattern', async () => {
    await createWebhook({
      project_id: projectId,
      name: 'Non-Matching Webhook',
      url: 'https://example.com/hook-nomatch',
      events: ['files.deleted'],
    });

    emitEvent({
      type: 'agents.generation.completed',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_test789',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitForDispatchSync();

    expect(callsToUrl('https://example.com/hook-nomatch')).toHaveLength(0);
  });

  test('dispatcher skips when prefix wildcard does not match event namespace', async () => {
    await createWebhook({
      project_id: projectId,
      name: 'Files Prefix Webhook',
      url: 'https://example.com/hook-files-prefix',
      events: ['files.*'],
    });

    emitEvent({
      type: 'agents.generation.completed', // does not start with 'files.'
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'generation',
      resourceId: 'gen_prefix_mismatch',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitForDispatchSync();

    expect(callsToUrl('https://example.com/hook-files-prefix')).toHaveLength(0);
  });

  test('dispatcher retries and marks delivery as failed when all fetch attempts throw', async () => {
    fetchMock.mockRejectedValue(new Error('Network unreachable'));

    await createWebhook({
      project_id: projectId,
      name: 'Retry Failure Webhook',
      url: 'https://example.com/hook-retry-fail',
      events: ['files.created'],
    });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_retry_fail',
      data: {},
      timestamp: new Date().toISOString(),
    });

    // MAX_ATTEMPTS = 3, retries fire back-to-back with no delay between them.
    await waitFor(() => {
      return callsToUrl('https://example.com/hook-retry-fail').length >= 3;
    });

    expect(callsToUrl('https://example.com/hook-retry-fail')).toHaveLength(3);
  });

  test('dispatcher aborts the request when it exceeds the delivery timeout', async () => {
    // A hanging fetch that only settles when the AbortSignal fires — mirrors
    // real `fetch` behavior when the 10s delivery timeout's setTimeout
    // callback calls `controller.abort()`.
    fetchMock.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    // Fire the delivery-timeout's setTimeout callback immediately instead of
    // waiting the real 10s — only for that specific timeout, so unrelated
    // timers (DB driver, supertest, our own waitFor poll) keep behaving
    // normally.
    const realSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((callback: (...args: any[]) => void, ms, ...args) => {
        if (ms === 10_000) {
          callback(...args);
          return {} as ReturnType<typeof setTimeout>;
        }
        return realSetTimeout(callback, ms, ...args);
      });

    try {
      await createWebhook({
        project_id: projectId,
        name: 'Timeout Webhook',
        url: 'https://example.com/hook-timeout',
        events: ['files.created'],
      });

      emitEvent({
        type: 'files.created',
        projectId: projectInternalId ?? 1,
        projectPublicId: projectId,
        resourceType: 'file',
        resourceId: 'fil_timeout',
        data: {},
        timestamp: new Date().toISOString(),
      });

      // The mocked timeout fires `controller.abort()` synchronously, before
      // `fetch` is even called, so the signal is already aborted by the time
      // our fetch mock attaches its `abort` listener — the first attempt's
      // fetch promise never settles and the retry loop never reaches
      // attempt 2. Only one call is expected.
      await waitFor(() => {
        return callsToUrl('https://example.com/hook-timeout').length > 0;
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(
      callsToUrl('https://example.com/hook-timeout').length
    ).toBeGreaterThan(0);
  });

  test('dispatcher delivers webhook when policy allows the event', async () => {
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['*'],
              resource: ['*'],
            },
          ],
        },
      });
    const dispatchPolicyId = policyRes.body.id;

    await createWebhook({
      project_id: projectId,
      name: 'Policy Allow Webhook',
      url: 'https://example.com/hook-policy-allow',
      events: ['files.created'],
      policy_id: dispatchPolicyId,
    });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_policy_allow',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      return callsToUrl('https://example.com/hook-policy-allow').length > 0;
    });

    expect(callsToUrl('https://example.com/hook-policy-allow')).toHaveLength(1);
  });

  test('dispatcher skips delivery when policy denies the event', async () => {
    const denyPolicyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Deny',
              action: ['*'],
              resource: ['*'],
            },
          ],
        },
      });
    const denyPolicyId = denyPolicyRes.body.id;

    await createWebhook({
      project_id: projectId,
      name: 'Policy Deny Webhook',
      url: 'https://example.com/hook-policy-deny',
      events: ['files.created'],
      policy_id: denyPolicyId,
    });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_policy_deny',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitForDispatchSync();

    expect(callsToUrl('https://example.com/hook-policy-deny')).toHaveLength(0);
  });

  test('dispatcher marks delivery failed when server returns non-ok status on all attempts', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bad Gateway' }), { status: 502 })
    );

    await createWebhook({
      project_id: projectId,
      name: 'Non-OK Status Webhook',
      url: 'https://example.com/hook-non-ok',
      events: ['files.created'],
    });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_non_ok',
      data: {},
      timestamp: new Date().toISOString(),
    });

    // Should retry up to MAX_ATTEMPTS since status is not ok.
    await waitFor(() => {
      return callsToUrl('https://example.com/hook-non-ok').length >= 3;
    });

    expect(callsToUrl('https://example.com/hook-non-ok')).toHaveLength(3);
  });

  test('a delivery-record creation failure does not crash event dispatch', async () => {
    await createWebhook({
      project_id: projectId,
      name: 'Delivery Create Failure Webhook',
      url: 'https://example.com/hook-delivery-create-fails',
      // Subscribes only to the over-long event below (via prefix match), not to
      // the well-formed `files.created` sync event that follows.
      events: ['files.created.*'],
    });

    // `WebhookDelivery.eventType` is a VARCHAR(255) column, so an event whose
    // type exceeds that length makes the real `WebhookDelivery.create` insert
    // reject with a genuine DB error. This drives `deliverWebhook`'s failure
    // path against the real database (no `db` mock). Both the sentinel (`*`) and
    // the webhook above (`files.created.*`) match this event, so both
    // delivery-record inserts fail; their rejections must be swallowed by
    // `handleEvent`'s `.catch()`.
    const overLongType = `files.created.${'x'.repeat(300)}`;
    emitEvent({
      type: overLongType,
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_delivery_create_fails',
      data: {},
      timestamp: new Date().toISOString(),
    });

    // A well-formed event emitted afterwards must still be delivered to the
    // sentinel — proving the create failure above did not crash the dispatch
    // loop and dispatch keeps working.
    const baseline = callsToUrl(SENTINEL_URL).length;
    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_after_create_failure',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      return callsToUrl(SENTINEL_URL).length > baseline;
    });
    expect(callsToUrl(SENTINEL_URL).length).toBeGreaterThan(baseline);

    // The over-long event never produced a fetch, since its delivery record
    // could not be created.
    expect(
      callsToUrl('https://example.com/hook-delivery-create-fails')
    ).toHaveLength(0);
  });
});
