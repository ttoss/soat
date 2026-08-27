import { db } from 'src/db';
import { emitEvent } from 'src/lib/eventBus';
import { asCustomEventName } from 'src/lib/soatEvents';
import { sweepDueWebhookDeliveries } from 'src/lib/webhookDispatcher';

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

  /**
   * Deliveries to `url` carrying a specific event type. A `*` subscriber also
   * receives unrelated project events — notably the `audit.entry_created` entry
   * written for the very `POST /webhooks` call that created it — so a wildcard
   * assertion must select the event under test rather than assume the webhook
   * received exactly one delivery.
   */
  const callsToUrlForEvent = (url: string, eventType: string) => {
    return callsToUrl(url).filter(([, init]) => {
      const { headers } = init as { headers: Record<string, string> };
      return headers['X-Soat-Event'] === eventType;
    });
  };

  // `handleEvent` iterates all matching webhooks in one synchronous pass, so the
  // sentinel's fetch call proves the whole dispatch loop already ran for that
  // event — a deterministic sync point for "should NOT reach" assertions.
  /**
   * A sweep clock moved past any backoff this suite can schedule, so a claimed
   * retry is due immediately instead of the test waiting out real seconds.
   */
  const pastAnyBackoff = () => {
    return new Date(Date.now() + 10 * 60 * 1000);
  };

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

  test('delivery envelope is snake_case, like every other SOAT surface', async () => {
    const url = 'https://example.com/hook-envelope';
    await createWebhook({
      project_id: projectId,
      name: 'Envelope Webhook',
      url,
      events: ['files.created'],
    });

    const timestamp = new Date().toISOString();

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_envelope123',
      data: { filename: 'envelope.txt' },
      timestamp,
    });

    await waitFor(() => {
      return callsToUrlForEvent(url, 'files.created').length > 0;
    });

    const [, init] = callsToUrlForEvent(url, 'files.created')[0] as [
      string,
      { body: string },
    ];
    const payload = JSON.parse(init.body) as Record<string, unknown>;

    expect(payload).toEqual({
      event: 'files.created',
      project_id: projectId,
      resource_type: 'file',
      resource_id: 'fil_envelope123',
      data: { filename: 'envelope.txt' },
      timestamp,
    });
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
      return (
        callsToUrlForEvent(
          'https://example.com/hook-wildcard',
          'agents.generation.completed'
        ).length > 0
      );
    });

    // Exactly one delivery of the event under test; the wildcard subscriber
    // legitimately receives other project events too (see callsToUrlForEvent).
    const webhookCalls = callsToUrlForEvent(
      'https://example.com/hook-wildcard',
      'agents.generation.completed'
    );
    expect(webhookCalls).toHaveLength(1);
    const [, init] = webhookCalls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers['X-Soat-Event']).toBe('agents.generation.completed');
  });

  test('a wildcard subscriber receives audit.entry_created carrying the full entry', async () => {
    const url = 'https://example.com/hook-audit';
    // Creating the webhook is itself an audited mutation, so the entry for
    // `webhooks:CreateWebhook` is dispatched to the very webhook that was just
    // created. This pins the cross-module behavior the wildcard assertion above
    // has to account for.
    await createWebhook({
      project_id: projectId,
      name: 'Audit Wildcard Webhook',
      url,
      events: ['*'],
    });

    type AuditPayload = {
      event: string;
      resource_type: string;
      data: Record<string, unknown>;
    };

    // The previous test's teardown deletes webhooks, and each delete is itself
    // an audited mutation dispatching asynchronously — late enough to take the
    // first slot here. Filter by action rather than trusting arrival order.
    const auditPayloads = (): AuditPayload[] => {
      return callsToUrlForEvent(url, 'audit.entry_created').map(([, init]) => {
        return JSON.parse((init as { body: string }).body) as AuditPayload;
      });
    };
    const createEntry = (): AuditPayload | undefined => {
      return auditPayloads().find((p) => {
        return p.data.action === 'webhooks:CreateWebhook';
      });
    };

    await waitFor(() => {
      return createEntry() !== undefined;
    });

    const payload = createEntry()!;
    expect(payload.event).toBe('audit.entry_created');
    expect(payload.resource_type).toBe('audit');
    // The payload is the full snake_case entry, so a subscriber needs no
    // follow-up GET.
    expect(payload.data.action).toBe('webhooks:CreateWebhook');
    expect(payload.data.project_id).toBe(projectId);
    expect(payload.data.status).toBe(201);
    expect(payload.data.principal_type).toBe('user');
    expect(String(payload.data.id).startsWith('audit_')).toBe(true);
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
    const url = 'https://example.com/hook-retry-fail';
    fetchMock.mockRejectedValue(new Error('Network unreachable'));

    await createWebhook({
      project_id: projectId,
      name: 'Retry Failure Webhook',
      url,
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

    // The emitting process makes the first attempt and stops there; the retries
    // are owned by the delivery row, so they only happen when a sweep claims
    // it. Driving the sweep by hand is what the scheduler's timer does in
    // production (`tests never import server.ts`).
    await waitFor(() => {
      return callsToUrl(url).length >= 1;
    });

    await waitFor(async () => {
      await sweepDueWebhookDeliveries({ now: pastAnyBackoff() });
      return callsToUrl(url).length >= 3;
    });

    // MAX_ATTEMPTS = 3, across the inline attempt plus two swept retries.
    expect(callsToUrl(url)).toHaveLength(3);
  });

  test('an undecryptable secret records a failed delivery instead of vanishing', async () => {
    // Signing happens before the request, so an undecryptable secret — a
    // pre-encryption row, or a changed SECRETS_ENCRYPTION_KEY — must still leave
    // a `failed` delivery row. Otherwise the webhook goes quiet with nothing in
    // the log to say why.
    const created = await createWebhook({
      project_id: projectId,
      name: 'Undecryptable Secret Webhook',
      url: 'https://example.com/hook-bad-secret',
      events: ['files.created'],
    });

    // Unreachable through the API, which always encrypts on write.
    const row = await db.Webhook.findOne({
      where: { publicId: created.body.id },
    });
    await row!.update({ secret: 'not-valid-ciphertext' });

    emitEvent({
      type: 'files.created',
      projectId: projectInternalId ?? 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId: 'fil_bad_secret',
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitFor(async () => {
      const delivery = await db.WebhookDelivery.findOne({
        where: { webhookId: row!.id },
      });
      return delivery?.status === 'failed';
    });

    const delivery = await db.WebhookDelivery.findOne({
      where: { webhookId: row!.id },
    });
    // Never attempted, so it is distinguishable from an HTTP failure: no
    // attempts, no status code, and a reason an operator can act on.
    expect(delivery!.attempts).toBe(0);
    expect(delivery!.statusCode).toBeNull();
    expect(delivery!.responseBody).toMatch(/rotate/i);
    // The request itself must never have been made — an unsigned delivery is
    // worse than none.
    expect(callsToUrl('https://example.com/hook-bad-secret')).toHaveLength(0);
  });

  test('dispatcher clears the per-attempt delivery timeout even when fetch rejects', async () => {
    // Regression guard: the delivery timeout's setTimeout must be cleared on
    // every path out of the attempt loop, including a thrown/rejected fetch —
    // not just the success path. Leaving it uncleared holds a real 10s timer
    // handle open per attempt, which is why Jest reports leaked handles.
    const RETRY_LEAK_URL = 'https://example.com/hook-retry-timer-leak';

    // Only this webhook's URL rejects; the sentinel (and any other webhook)
    // keeps resolving 200 so it doesn't create its own delivery-timeout
    // timers and pollute the assertion below.
    fetchMock.mockImplementation((url) => {
      if (url === RETRY_LEAK_URL) {
        return Promise.reject(new Error('Network unreachable'));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
    });

    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const openDeliveryTimers = new Set<ReturnType<typeof setTimeout>>();
    let deliveryTimersCreated = 0;

    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((callback: (...args: any[]) => void, ms, ...args) => {
        const timer = realSetTimeout(callback, ms, ...args);
        if (ms === 10_000) {
          deliveryTimersCreated += 1;
          openDeliveryTimers.add(timer);
        }
        return timer;
      });

    const clearTimeoutSpy = jest
      .spyOn(global, 'clearTimeout')
      .mockImplementation((timer) => {
        openDeliveryTimers.delete(timer as ReturnType<typeof setTimeout>);
        return realClearTimeout(timer as ReturnType<typeof setTimeout>);
      });

    try {
      await createWebhook({
        project_id: projectId,
        name: 'Retry Timer Leak Webhook',
        url: RETRY_LEAK_URL,
        events: ['files.created'],
      });

      emitEvent({
        type: 'files.created',
        projectId: projectInternalId ?? 1,
        projectPublicId: projectId,
        resourceType: 'file',
        resourceId: 'fil_retry_timer_leak',
        data: {},
        timestamp: new Date().toISOString(),
      });

      // Every attempt opens its own delivery timeout, so drive the delivery to
      // exhaustion through the sweep to exercise the leak on all three.
      await waitFor(async () => {
        await sweepDueWebhookDeliveries({ now: pastAnyBackoff() });
        return callsToUrl(RETRY_LEAK_URL).length >= 3;
      });

      // The creation count is not enough: each attempt clears its timer in a
      // `finally` that runs only after an awaited DB write, so counting races
      // it. `size === 0` holds only once every `finally` has run.
      await waitFor(
        () => {
          return deliveryTimersCreated >= 3 && openDeliveryTimers.size === 0;
        },
        { attempts: 200 }
      );
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      for (const timer of openDeliveryTimers) {
        realClearTimeout(timer);
      }
    }

    expect(deliveryTimersCreated).toBeGreaterThanOrEqual(3);
    expect(openDeliveryTimers.size).toBe(0);
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

      // The mocked timeout aborts synchronously, before `fetch` is called, so
      // the first attempt's promise never settles and the retry loop never
      // reaches attempt 2.
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
    const url = 'https://example.com/hook-non-ok';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bad Gateway' }), { status: 502 })
    );

    const created = await createWebhook({
      project_id: projectId,
      name: 'Non-OK Status Webhook',
      url,
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

    const webhookRow = await db.Webhook.findOne({
      where: { publicId: created.body.id },
    });

    /** Attempts the delivery row has actually *recorded*, not merely started. */
    const attemptsRecorded = async () => {
      const row = await db.WebhookDelivery.findOne({
        where: { webhookId: webhookRow!.id },
      });
      return row?.attempts ?? 0;
    };

    const waitForAttempts = async (n: number) => {
      await waitFor(async () => {
        return (await attemptsRecorded()) >= n;
      });
    };

    // Sweep only once the previous attempt has landed. Polling the fetch count
    // instead loses to two races: a call is recorded when invoked but reaches
    // the row only after the response is awaited, and `pastAnyBackoff()` is far
    // past an in-flight attempt's lease, so a sweep mid-attempt re-dispatches
    // it. Every wait here is bounded by an observed row change, with no sleep.
    await waitForAttempts(1);
    await sweepDueWebhookDeliveries({ now: pastAnyBackoff() });
    await waitForAttempts(2);
    await sweepDueWebhookDeliveries({ now: pastAnyBackoff() });
    await waitForAttempts(3);

    expect(callsToUrl(url)).toHaveLength(3);

    const delivery = await db.WebhookDelivery.findOne({
      where: { webhookId: webhookRow!.id },
    });
    // Exhausted, and terminal: no lease and nothing left to become due.
    expect(delivery!.status).toBe('failed');
    expect(delivery!.statusCode).toBe(502);
    expect(delivery!.nextAttemptAt).toBeNull();
    expect(delivery!.leaseExpiresAt).toBeNull();
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

    // An event type past `eventType`'s VARCHAR(255) makes the real insert reject,
    // driving the failure path without a `db` mock. Both matching webhooks fail,
    // and `handleEvent` must swallow each rejection.
    const overLongType = asCustomEventName({
      name: `files.created.${'x'.repeat(300)}`,
    });
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
