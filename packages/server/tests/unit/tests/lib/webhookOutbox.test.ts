import crypto from 'node:crypto';

import { db } from 'src/db';
import { emitEvent } from 'src/lib/eventBus';
import { sweepDueWebhookDeliveries } from 'src/lib/webhookDispatcher';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The outbox half of the dispatcher: a delivery is a database row with its own
 * due time, and every attempt after the first is driven by the scheduler sweep
 * rather than by a loop living in the emitting request's process.
 *
 * These drive {@link sweepDueWebhookDeliveries} directly, the same way the
 * orchestration tests drive `wakeDueRuns` — unit tests never import
 * `server.ts`, so the interval timer does not exist here.
 */

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

describe('webhook delivery outbox', () => {
  let adminToken: string;
  let projectId: string;
  let fetchMock: jest.SpyInstance;

  const createWebhook = async (args: { name: string; url: string }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/webhooks')
      .send({
        project_id: projectId,
        name: args.name,
        url: args.url,
        events: ['files.created'],
      });
    return res.body as { id: string; secret: string };
  };

  const webhookRow = async (publicId: string) => {
    const row = await db.Webhook.findOne({ where: { publicId } });
    return row!;
  };

  const deliveriesFor = async (webhookInternalId: number) => {
    return db.WebhookDelivery.findAll({
      where: { webhookId: webhookInternalId },
      order: [['createdAt', 'ASC']],
    });
  };

  const callsToUrl = (url: string) => {
    return fetchMock.mock.calls.filter(([calledUrl]) => {
      return calledUrl === url;
    });
  };

  const emitFileCreated = (resourceId: string) => {
    emitEvent({
      type: 'files.created',
      projectId: 1,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId,
      data: { filename: `${resourceId}.txt` },
      timestamp: new Date().toISOString(),
    });
  };

  /** The sweep's clock, moved past any backoff this suite can schedule. */
  const laterThanAnyBackoff = () => {
    return new Date(Date.now() + 10 * 60 * 1000);
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'webhookoutboxadmin', password: 'supersecret' });

    adminToken = await loginAs('webhookoutboxadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Webhook Outbox Test Project' });

    projectId = projectRes.body.id;
  });

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  test('a failed attempt schedules a backed-off retry instead of looping in-process', async () => {
    const url = 'https://example.com/outbox-backoff';
    fetchMock.mockImplementation((calledUrl: string) => {
      if (calledUrl === url) return Promise.reject(new Error('unreachable'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const webhook = await createWebhook({ name: 'Backoff', url });
    const row = await webhookRow(webhook.id);

    emitFileCreated('fil_backoff');

    await waitFor(async () => {
      const [delivery] = await deliveriesFor(row.id);
      return delivery?.attempts === 1;
    });

    // One attempt happened, and the row carries its own future due time — the
    // retry lives in the database, not in the process that emitted the event.
    expect(callsToUrl(url)).toHaveLength(1);

    const [delivery] = await deliveriesFor(row.id);
    expect(delivery.status).toBe('pending');
    expect(delivery.nextAttemptAt).not.toBeNull();
    expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // The lease is released so a sweep in any process can claim the retry.
    expect(delivery.leaseExpiresAt).toBeNull();
  });

  test('a sweep retries the delivery once its backoff has elapsed', async () => {
    const url = 'https://example.com/outbox-retry';
    fetchMock.mockImplementation((calledUrl: string) => {
      if (calledUrl === url) return Promise.reject(new Error('unreachable'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const webhook = await createWebhook({ name: 'Retry', url });
    const row = await webhookRow(webhook.id);

    emitFileCreated('fil_retry');

    await waitFor(async () => {
      const [delivery] = await deliveriesFor(row.id);
      return delivery?.attempts === 1;
    });

    const claimed = await sweepDueWebhookDeliveries({
      now: laterThanAnyBackoff(),
    });
    expect(claimed).toBeGreaterThan(0);

    await waitFor(async () => {
      const [delivery] = await deliveriesFor(row.id);
      return delivery.attempts === 2;
    });

    expect(callsToUrl(url)).toHaveLength(2);
  });

  test('a delivery stranded mid-flight by a restart is reclaimed once its lease expires', async () => {
    const url = 'https://example.com/outbox-stranded';
    const webhook = await createWebhook({ name: 'Stranded', url });
    const row = await webhookRow(webhook.id);

    // The state a killed process leaves behind: the row was persisted and
    // leased, then nobody ever came back to finish the attempt. Unreachable
    // through the API, which is the point — nothing in-process can recover it.
    const stranded = await db.WebhookDelivery.create({
      webhookId: row.id,
      eventType: 'files.created',
      payload: { event: 'files.created', resource_id: 'fil_stranded' },
      status: 'pending',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 60_000),
      leaseExpiresAt: new Date(Date.now() - 30_000),
    });

    const claimed = await sweepDueWebhookDeliveries();
    expect(claimed).toBeGreaterThan(0);

    await waitFor(() => {
      return callsToUrl(url).length > 0;
    });

    await stranded.reload();
    expect(stranded.status).toBe('success');
  });

  test('a delivery still inside its lease is left alone', async () => {
    const url = 'https://example.com/outbox-leased';
    const webhook = await createWebhook({ name: 'Leased', url });
    const row = await webhookRow(webhook.id);

    await db.WebhookDelivery.create({
      webhookId: row.id,
      eventType: 'files.created',
      payload: { event: 'files.created' },
      status: 'pending',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 60_000),
      // Another process is working on it right now.
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await sweepDueWebhookDeliveries();

    expect(callsToUrl(url)).toHaveLength(0);
  });

  test('attempts stop at the cap and the delivery is marked failed', async () => {
    const url = 'https://example.com/outbox-exhausted';
    fetchMock.mockImplementation((calledUrl: string) => {
      if (calledUrl === url) return Promise.reject(new Error('unreachable'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const webhook = await createWebhook({ name: 'Exhausted', url });
    const row = await webhookRow(webhook.id);

    emitFileCreated('fil_exhausted');

    await waitFor(async () => {
      const [delivery] = await deliveriesFor(row.id);
      return delivery?.attempts === 1;
    });

    // Drive the sweep until the delivery stops being retried.
    await waitFor(async () => {
      await sweepDueWebhookDeliveries({ now: laterThanAnyBackoff() });
      const [delivery] = await deliveriesFor(row.id);
      return delivery.status === 'failed';
    });

    const [delivery] = await deliveriesFor(row.id);
    expect(delivery.attempts).toBe(3);
    expect(delivery.status).toBe('failed');
    expect(callsToUrl(url)).toHaveLength(3);

    // A failed row is terminal: further sweeps must not resurrect it.
    await sweepDueWebhookDeliveries({ now: laterThanAnyBackoff() });
    expect(callsToUrl(url)).toHaveLength(3);
  });

  test('the signature is timestamped and verifies over `t.payload`', async () => {
    const url = 'https://example.com/outbox-signature';
    const webhook = await createWebhook({ name: 'Signature', url });

    emitFileCreated('fil_signature');

    await waitFor(() => {
      return callsToUrl(url).length > 0;
    });

    const [, init] = callsToUrl(url)[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];

    const header = init.headers['X-Soat-Signature-V2'];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const [timestampPart, signaturePart] = header.split(',');
    const timestamp = timestampPart.slice('t='.length);
    const signature = signaturePart.slice('v1='.length);

    // The subscriber recomputes it exactly as the docs describe.
    const expected = crypto
      .createHmac('sha256', webhook.secret)
      .update(`${timestamp}.${init.body}`)
      .digest('hex');
    expect(signature).toBe(expected);

    // The timestamp is what bounds a replay, so it has to be the real send
    // time rather than a constant.
    const skewSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    expect(skewSeconds).toBeLessThan(120);
  });

  test('the legacy signature header is still sent during the deprecation window', async () => {
    const url = 'https://example.com/outbox-legacy-signature';
    const webhook = await createWebhook({ name: 'Legacy Signature', url });

    emitFileCreated('fil_legacy_signature');

    await waitFor(() => {
      return callsToUrl(url).length > 0;
    });

    const [, init] = callsToUrl(url)[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];

    const legacy = crypto
      .createHmac('sha256', webhook.secret)
      .update(init.body)
      .digest('hex');
    expect(init.headers['X-Soat-Signature']).toBe(`sha256=${legacy}`);
  });

  test('each attempt re-signs, so a retry never ships a stale timestamp', async () => {
    const url = 'https://example.com/outbox-resign';
    fetchMock.mockImplementation((calledUrl: string) => {
      if (calledUrl === url) return Promise.reject(new Error('unreachable'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const webhook = await createWebhook({ name: 'Resign', url });
    const row = await webhookRow(webhook.id);

    emitFileCreated('fil_resign');

    await waitFor(async () => {
      const [delivery] = await deliveriesFor(row.id);
      return delivery?.attempts === 1;
    });

    const sweepNow = laterThanAnyBackoff();
    await sweepDueWebhookDeliveries({ now: sweepNow });

    await waitFor(() => {
      return callsToUrl(url).length === 2;
    });

    const timestampOf = (index: number) => {
      const [, init] = callsToUrl(url)[index] as [
        string,
        { headers: Record<string, string> },
      ];
      return Number(
        init.headers['X-Soat-Signature-V2'].split(',')[0].slice('t='.length)
      );
    };

    // Re-signed rather than replayed: a subscriber enforcing a tolerance window
    // would reject the retry if it carried the first attempt's timestamp.
    expect(timestampOf(1)).toBeGreaterThanOrEqual(timestampOf(0));
  });
});
