import crypto from 'node:crypto';

import { db } from 'src/db';
import { sweepDueWebhookDeliveries } from 'src/lib/webhookDispatcher';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Webhook delivery driven by the event flow: `POST /api/v1/files` emits
 * `files.created`, the dispatcher writes a delivery row and attempts it, and
 * every later attempt is the outbox sweep's — the scheduler tick, driven here
 * by hand because unit tests never import `server.ts`. Outcomes are read back
 * through `GET /api/v1/webhook-deliveries`.
 *
 * `fetch` is the outbound HTTP boundary and is stubbed per URL. Every webhook
 * in the project sees every later test's file, so each assertion selects the
 * delivery for the file its own test created.
 */

type Delivery = {
  id: string;
  status: string;
  status_code: number | null;
  attempts: number;
  next_attempt_at: string | null;
  response_body: string | null;
  payload: { resource_id?: string } & Record<string, unknown>;
};

type FetchInit = { method?: string; headers?: HeadersInit; body?: string };

describe('Webhook delivery', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let fetchMock: jest.SpyInstance;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createWebhook = async (args: {
    url: string;
    events: string[];
    policyId?: string;
  }): Promise<{ id: string; secret: string }> => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/webhooks')
      .send({
        project_id: projectId,
        name: `delivery-hook-${seq}`,
        url: args.url,
        events: args.events,
        ...(args.policyId ? { policy_id: args.policyId } : {}),
      });
    expect(res.status).toBe(201);
    return { id: res.body.id, secret: res.body.secret };
  };

  const createFile = async (): Promise<string> => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/files')
      .send({ project_id: projectId, filename: `delivery-${seq}.txt` });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const deliveryFor = async (args: {
    webhookId: string;
    fileId: string;
  }): Promise<Delivery | undefined> => {
    const res = await asUser().get(
      `/api/v1/webhook-deliveries?webhook_id=${args.webhookId}&limit=100`
    );
    expect(res.status).toBe(200);
    return (res.body.data as Delivery[]).find((delivery) => {
      return delivery.payload.resource_id === args.fileId;
    });
  };

  /** Polls the delivery through the API until `done` holds. */
  const waitForDelivery = async (args: {
    webhookId: string;
    fileId: string;
    done: (delivery: Delivery) => boolean;
  }): Promise<Delivery> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const delivery = await deliveryFor(args);
      if (delivery && args.done(delivery)) return delivery;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`delivery for ${args.fileId} never settled`);
  };

  const callsTo = (url: string): FetchInit[] => {
    return fetchMock.mock.calls
      .filter(([calledUrl]) => {
        return calledUrl === url;
      })
      .map(([, init]) => {
        return init as FetchInit;
      });
  };

  const header = (init: FetchInit, name: string) => {
    return new Headers(init.headers).get(name);
  };

  const signatureTimestamp = (init: FetchInit) => {
    return Number(
      (header(init, 'X-Soat-Signature') ?? '').split(',')[0].slice('t='.length)
    );
  };

  /** A sweep clock past any backoff this suite schedules. */
  const pastAnyBackoff = () => {
    return new Date(Date.now() + 10 * 60 * 1000);
  };

  const rejectFor = (url: string) => {
    fetchMock.mockImplementation((calledUrl: string) => {
      if (calledUrl === url) return Promise.reject(new Error('unreachable'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'whdelivery',
      policyActions: [
        'files:CreateFile',
        'webhooks:CreateWebhook',
        'webhooks:ListWebhookDeliveries',
        'webhooks:GetWebhookDelivery',
        'webhooks:RedeliverWebhookDelivery',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/v1/files → a subscribed webhook', () => {
    test('receives one signed, snake_case envelope, recorded as a success', async () => {
      const url = 'https://example.com/delivery-envelope';
      const webhook = await createWebhook({ url, events: ['files.created'] });

      const fileId = await createFile();
      const delivery = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.status === 'success';
        },
      });

      expect(delivery.attempts).toBe(1);
      expect(delivery.status_code).toBe(200);
      expect(delivery.next_attempt_at).toBeNull();

      const calls = callsTo(url);
      expect(calls).toHaveLength(1);
      const [init] = calls;
      expect(init.method).toBe('POST');
      expect(header(init, 'X-Soat-Event')).toBe('files.created');
      expect(header(init, 'X-Soat-Delivery')).toBe(delivery.id);

      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        event: 'files.created',
        project_id: projectId,
        resource_type: 'file',
        resource_id: fileId,
        data: expect.objectContaining({ id: fileId }),
        timestamp: expect.any(String),
      });

      // One scheme under one header: a second header offers a subscriber a
      // name to guess wrong, and a bare-body scheme has no replay bound.
      const signature = header(init, 'X-Soat-Signature') ?? '';
      expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(header(init, 'X-Soat-Signature-V2')).toBeNull();

      const [timestampPart, digestPart] = signature.split(',');
      const timestamp = timestampPart.slice('t='.length);
      expect(digestPart.slice('v1='.length)).toBe(
        crypto
          .createHmac('sha256', webhook.secret)
          .update(`${timestamp}.${init.body}`)
          .digest('hex')
      );
      // The timestamp bounds a replay, so it is the send time, not a constant.
      expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(120);
    });

    test('matches exact, prefix and `*` patterns and skips the rest', async () => {
      const urls = {
        star: 'https://example.com/delivery-star',
        prefix: 'https://example.com/delivery-prefix',
        otherVerb: 'https://example.com/delivery-other-verb',
        otherNamespace: 'https://example.com/delivery-other-namespace',
      };
      const star = await createWebhook({ url: urls.star, events: ['*'] });
      const prefix = await createWebhook({
        url: urls.prefix,
        events: ['files.*'],
      });
      const otherVerb = await createWebhook({
        url: urls.otherVerb,
        events: ['files.deleted'],
      });
      const otherNamespace = await createWebhook({
        url: urls.otherNamespace,
        events: ['agents.*'],
      });

      const fileId = await createFile();
      const settled = (d: Delivery) => {
        return d.status === 'success';
      };
      await waitForDelivery({ webhookId: star.id, fileId, done: settled });
      await waitForDelivery({ webhookId: prefix.id, fileId, done: settled });

      // Matching runs in one pass before any row is written, so once a
      // matched row exists every webhook has had its chance to match.
      expect(
        await deliveryFor({ webhookId: otherVerb.id, fileId })
      ).toBeUndefined();
      expect(
        await deliveryFor({ webhookId: otherNamespace.id, fileId })
      ).toBeUndefined();
    });

    test('an attached policy decides whether the event is delivered', async () => {
      const createPolicy = async (effect: string): Promise<string> => {
        const res = await authenticatedTestClient(adminToken)
          .post('/api/v1/policies')
          .send({
            document: {
              statement: [{ effect, action: ['*'], resource: ['*'] }],
            },
          });
        expect(res.status).toBe(201);
        return res.body.id;
      };
      const denied = await createWebhook({
        url: 'https://example.com/delivery-policy-deny',
        events: ['files.created'],
        policyId: await createPolicy('Deny'),
      });
      const allowed = await createWebhook({
        url: 'https://example.com/delivery-policy-allow',
        events: ['files.created'],
        policyId: await createPolicy('Allow'),
      });

      const first = await createFile();
      const second = await createFile();
      const settled = (d: Delivery) => {
        return d.status === 'success';
      };
      await waitForDelivery({
        webhookId: allowed.id,
        fileId: first,
        done: settled,
      });
      // The second file's delivery lands after the first event's whole pass,
      // so the denied webhook has had its evaluation for both by now.
      await waitForDelivery({
        webhookId: allowed.id,
        fileId: second,
        done: settled,
      });

      expect(
        await deliveryFor({ webhookId: denied.id, fileId: first })
      ).toBeUndefined();
      expect(
        await deliveryFor({ webhookId: denied.id, fileId: second })
      ).toBeUndefined();
    });
  });

  describe('a failing endpoint → the outbox sweep', () => {
    test('retries behind a backoff, re-signs each attempt, and fails at the cap', async () => {
      const url = 'https://example.com/delivery-retry';
      rejectFor(url);
      const webhook = await createWebhook({ url, events: ['files.created'] });

      // Every attempt opens a 10s abort timer; each must be cleared on the
      // rejecting path too, or it holds a handle open per attempt.
      const realSetTimeout = global.setTimeout;
      const realClearTimeout = global.clearTimeout;
      const openDeliveryTimers = new Set<ReturnType<typeof setTimeout>>();
      let deliveryTimers = 0;
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation(
          (callback: (...args: unknown[]) => void, ms?: number) => {
            const timer = realSetTimeout(callback, ms);
            if (ms === 10_000) {
              deliveryTimers += 1;
              openDeliveryTimers.add(timer);
            }
            return timer;
          }
        );
      jest
        .spyOn(global, 'clearTimeout')
        .mockImplementation(
          (timer?: string | number | ReturnType<typeof setTimeout>) => {
            if (typeof timer === 'object') openDeliveryTimers.delete(timer);
            realClearTimeout(timer);
          }
        );

      const fileId = await createFile();
      const first = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.attempts === 1;
        },
      });

      // The retry lives on the row, not in a loop in the emitting process.
      expect(first.status).toBe('pending');
      expect(first.status_code).toBeNull();
      expect(first.response_body).toBe('unreachable');
      expect(
        new Date(first.next_attempt_at as string).getTime()
      ).toBeGreaterThan(Date.now());
      expect(callsTo(url)).toHaveLength(1);

      // Not yet due: the backoff has not elapsed on the real clock.
      await sweepDueWebhookDeliveries({ now: new Date() });
      expect(callsTo(url)).toHaveLength(1);

      expect(
        await sweepDueWebhookDeliveries({ now: pastAnyBackoff() })
      ).toBeGreaterThan(0);
      await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.attempts === 2;
        },
      });
      await sweepDueWebhookDeliveries({ now: pastAnyBackoff() });
      const exhausted = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.attempts === 3;
        },
      });

      expect(exhausted.status).toBe('failed');
      expect(exhausted.next_attempt_at).toBeNull();
      const calls = callsTo(url);
      expect(calls).toHaveLength(3);
      // Re-signed rather than replayed, so a tolerance window accepts a retry.
      expect(signatureTimestamp(calls[1])).toBeGreaterThanOrEqual(
        signatureTimestamp(calls[0])
      );

      // Terminal: a further sweep does not resurrect it.
      await sweepDueWebhookDeliveries({ now: pastAnyBackoff() });
      expect(callsTo(url)).toHaveLength(3);

      for (let i = 0; i < 200 && openDeliveryTimers.size > 0; i += 1) {
        await new Promise((resolve) => {
          return realSetTimeout(resolve, 10);
        });
      }
      expect(deliveryTimers).toBeGreaterThanOrEqual(3);
      expect(openDeliveryTimers.size).toBe(0);
    });

    test('a non-ok answer is recorded with its status and a bounded body', async () => {
      const url = 'https://example.com/delivery-chatty';
      fetchMock.mockImplementation((calledUrl: string) => {
        return Promise.resolve(
          calledUrl === url
            ? new Response('x'.repeat(50_000), { status: 502 })
            : new Response('{}', { status: 200 })
        );
      });
      const webhook = await createWebhook({ url, events: ['files.created'] });

      const fileId = await createFile();
      const delivery = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.attempts === 1;
        },
      });

      expect(delivery.status).toBe('pending');
      expect(delivery.status_code).toBe(502);
      // Tenant-written URL, body readable back: the row keeps the first KB.
      expect(delivery.response_body).toHaveLength(1024);
    });

    test('an answer whose body cannot be read is recorded without one', async () => {
      const url = 'https://example.com/delivery-unreadable';
      fetchMock.mockImplementation((calledUrl: string) => {
        if (calledUrl !== url) {
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        // The connection drops after the status line.
        const body = new ReadableStream({
          start: (controller) => {
            controller.error(new Error('socket hang up'));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      });
      const webhook = await createWebhook({ url, events: ['files.created'] });

      const fileId = await createFile();
      const delivery = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.status === 'success';
        },
      });

      expect(delivery.status_code).toBe(200);
      expect(delivery.response_body).toBeNull();
    });

    test('a request past the delivery timeout is aborted and retried later', async () => {
      const url = 'https://example.com/delivery-timeout';
      fetchMock.mockImplementation((calledUrl: string, init?: FetchInit) => {
        if (calledUrl !== url) {
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        return new Promise((_resolve, reject) => {
          const { signal } = init as { signal: AbortSignal };
          signal.addEventListener('abort', () => {
            reject(new Error('This operation was aborted'));
          });
        });
      });
      // The 10s delivery timeout fires at once; every other timer is real.
      const realSetTimeout = global.setTimeout;
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation(
          (callback: (...args: unknown[]) => void, ms?: number) => {
            return realSetTimeout(callback, ms === 10_000 ? 0 : ms);
          }
        );
      const webhook = await createWebhook({ url, events: ['files.created'] });

      const fileId = await createFile();
      const delivery = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.attempts === 1;
        },
      });

      expect(delivery.status).toBe('pending');
      expect(delivery.response_body).toBe('This operation was aborted');
    });
  });

  describe('leases', () => {
    test('an attempt in flight is left alone until its lease lapses, then reclaimed', async () => {
      const url = 'https://example.com/delivery-stranded';
      // The first attempt never answers: the state a process that died
      // mid-request leaves behind is a leased row nobody finishes.
      let hangs = true;
      fetchMock.mockImplementation((calledUrl: string) => {
        if (calledUrl === url && hangs) {
          hangs = false;
          return new Promise(() => {});
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      const webhook = await createWebhook({ url, events: ['files.created'] });

      const fileId = await createFile();
      await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: () => {
          return callsTo(url).length === 1;
        },
      });

      // Inside the lease: another process is working on it.
      await sweepDueWebhookDeliveries({ now: new Date() });
      expect(callsTo(url)).toHaveLength(1);

      // Past the lease: nobody came back, so the sweep takes it over.
      await sweepDueWebhookDeliveries({
        now: new Date(Date.now() + 2 * 60 * 1000),
      });
      const delivery = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.status === 'success';
        },
      });
      expect(delivery.attempts).toBe(1);
      expect(callsTo(url)).toHaveLength(2);
    });
  });

  describe('POST /api/v1/webhook-deliveries/:delivery_id/redeliver → the sweep', () => {
    test('sends the queued copy on the next tick', async () => {
      const url = 'https://example.com/delivery-redeliver';
      const webhook = await createWebhook({ url, events: ['files.created'] });
      const fileId = await createFile();
      const original = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.status === 'success';
        },
      });

      const redeliver = await asUser().post(
        `/api/v1/webhook-deliveries/${original.id}/redeliver`
      );
      expect(redeliver.status).toBe(202);

      expect(
        await sweepDueWebhookDeliveries({ now: new Date() })
      ).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 200; i += 1) {
        const copy = await asUser().get(
          `/api/v1/webhook-deliveries/${redeliver.body.id}`
        );
        expect(copy.status).toBe(200);
        if (copy.body.status === 'success') break;
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }
      const copy = await asUser().get(
        `/api/v1/webhook-deliveries/${redeliver.body.id}`
      );
      expect(copy.body.status).toBe('success');
      expect(copy.body.attempts).toBe(1);
      expect(callsTo(url)).toHaveLength(2);
    });
  });

  describe('deliveries that can never succeed', () => {
    test('an undecryptable secret closes the delivery without a request', async () => {
      const url = 'https://example.com/delivery-bad-secret';
      const webhook = await createWebhook({ url, events: ['files.created'] });
      // The API always encrypts on write; this is a row written under a
      // different SECRETS_ENCRYPTION_KEY.
      await db.Webhook.update(
        { secret: 'not-valid-ciphertext' },
        { where: { publicId: webhook.id } }
      );

      const fileId = await createFile();
      const delivery = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.status === 'failed';
        },
      });

      // Never attempted: no attempt counted, no status code, and the remedy.
      expect(delivery.attempts).toBe(0);
      expect(delivery.status_code).toBeNull();
      expect(delivery.response_body).toMatch(/rotate/i);
      expect(callsTo(url)).toHaveLength(0);
    });

    test('a URL naming the deployment network is abandoned, never requested', async () => {
      const url = 'http://169.254.169.254/latest/meta-data/';
      const webhook = await createWebhook({ url, events: ['files.created'] });

      const fileId = await createFile();
      const delivery = await waitForDelivery({
        webhookId: webhook.id,
        fileId,
        done: (d) => {
          return d.status === 'failed';
        },
      });

      // No retry moves the URL, and each attempt would probe the host again.
      expect(delivery.attempts).toBe(0);
      expect(delivery.status_code).toBeNull();
      expect(delivery.response_body).toMatch(/not publicly routable/i);
      expect(callsTo(url)).toHaveLength(0);
    });
  });
});
