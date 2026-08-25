import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import type { SoatEvent } from './eventBus';
import { onEvent, recordDroppedEvent } from './eventBus';
import { evaluateEventPolicy, matchesEvent } from './eventMatching';
import { hmacHex, timestampedSignature } from './hmacSignature';
import { createScheduler, createSweep } from './scheduler';
import { retryTransient } from './transientRetry';
import { decryptWebhookSecret } from './webhooks';

const log = createDebug('soat:webhooks');

const MAX_ATTEMPTS = 3;
const DELIVERY_TIMEOUT_MS = 10_000;

/** First retry lands ~1s out, then ~2s, capped so a long outage stays polite. */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * How long a process may hold a delivery before another one may take it over.
 * This is the window an interrupted attempt stays stranded, so it is a
 * trade-off between duplicate sends (too short) and slow recovery (too long).
 */
const LEASE_MS = 60_000;

const SIGNATURE_HEADER = 'X-Soat-Signature-V2';
const LEGACY_SIGNATURE_HEADER = 'X-Soat-Signature';

type DeliveryRow = InstanceType<(typeof db)['WebhookDelivery']>;

/**
 * Both signature headers for one attempt.
 *
 * The v2 header is the shared `timestampedSignature` scheme (`hmacSignature.ts`)
 * — it signs `<timestamp>.<body>` and ships the timestamp alongside the digest,
 * so a subscriber can reject a replayed body by age. The legacy header signs the
 * bare body, which carries no such bound; it is still sent during the
 * deprecation window and is documented as deprecated.
 */
const signatureHeaders = (args: { payload: string; secret: string }) => {
  return {
    [SIGNATURE_HEADER]: timestampedSignature(args),
    [LEGACY_SIGNATURE_HEADER]: `sha256=${hmacHex({
      secret: args.secret,
      value: args.payload,
    })}`,
  };
};

/** Exponential backoff with jitter, so a fleet of retries does not sync up. */
const backoffMs = (args: { attempts: number }) => {
  const exponential = Math.min(
    BASE_BACKOFF_MS * 2 ** (args.attempts - 1),
    MAX_BACKOFF_MS
  );
  return exponential + Math.floor(Math.random() * exponential * 0.25);
};

/**
 * A delivery is due when it is still pending, its backoff has elapsed, and no
 * live lease is held on it. `nextAttemptAt: null` counts as due so rows written
 * before the outbox existed — stranded `pending` rows from a pre-upgrade
 * restart — are picked up by the first sweep after the deploy.
 */
const duePredicate = (args: { now: Date }) => {
  return {
    status: 'pending',
    [Op.and]: [
      {
        [Op.or]: [
          { nextAttemptAt: null },
          { nextAttemptAt: { [Op.lte]: args.now } },
        ],
      },
      {
        [Op.or]: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { [Op.lt]: args.now } },
        ],
      },
    ],
  };
};

type DeliveryOutcome = {
  status?: 'pending' | 'success' | 'failed';
  attempts?: number;
  lastAttemptAt?: Date;
  statusCode?: number | null;
  responseBody?: string | null;
  nextAttemptAt?: Date | null;
  leaseExpiresAt?: Date | null;
};

/**
 * Writes an attempt's outcome by primary key rather than through the instance's
 * `update`.
 *
 * The row was leased by a conditional `UPDATE` in the sweep's claim, which the
 * in-memory instance never saw. Instance `update` only writes attributes it
 * believes changed, so `leaseExpiresAt: null` against a stale `null` would be
 * dropped from the statement and the lease would stay in the database until it
 * expired — stalling every subsequent retry of that delivery.
 */
const writeOutcome = async (args: {
  delivery: DeliveryRow;
  values: DeliveryOutcome;
}) => {
  await db.WebhookDelivery.update(args.values, {
    where: { id: args.delivery.id as number },
  });
};

/**
 * Records the outcome of a failed attempt: either schedule the next one behind
 * a backoff, or give up at the cap. The lease is always released, because the
 * process that would have held it is done with this row either way.
 */
const recordFailedAttempt = async (args: {
  delivery: DeliveryRow;
  attempt: number;
  statusCode: number | null;
  responseBody: string | null;
}) => {
  const exhausted = args.attempt >= MAX_ATTEMPTS;

  await writeOutcome({
    delivery: args.delivery,
    values: {
      attempts: args.attempt,
      lastAttemptAt: new Date(),
      statusCode: args.statusCode,
      responseBody: args.responseBody,
      status: exhausted ? 'failed' : 'pending',
      nextAttemptAt: exhausted
        ? null
        : new Date(Date.now() + backoffMs({ attempts: args.attempt })),
      leaseExpiresAt: null,
    },
  });

  log(
    'recordFailedAttempt: delivery=%s attempt=%d exhausted=%s',
    args.delivery.publicId,
    args.attempt,
    exhausted
  );
};

/**
 * Ends a delivery without consuming an attempt: the cause is not something a
 * retry can fix, so the row is closed with the reason an operator needs rather
 * than left to burn its remaining attempts on the same failure. `attempts: 0`
 * and a null `statusCode` keep it distinguishable from an endpoint that
 * rejected the call.
 */
const abandonDelivery = async (args: {
  delivery: DeliveryRow;
  reason: string;
}) => {
  await writeOutcome({
    delivery: args.delivery,
    values: {
      status: 'failed',
      lastAttemptAt: new Date(),
      responseBody: args.reason,
      nextAttemptAt: null,
      leaseExpiresAt: null,
    },
  });
  log(
    'abandonDelivery: delivery=%s reason=%s',
    args.delivery.publicId,
    args.reason
  );
};

/**
 * Resolves everything an attempt needs before it touches the network, or closes
 * the delivery and returns `null` when it cannot.
 *
 * Signing happens here — before the request — so that a secret which cannot be
 * decrypted (a row written before secret-at-rest encryption, or a changed
 * `SECRETS_ENCRYPTION_KEY`) is *recorded* rather than thrown past the
 * fire-and-forget `.catch()` in `handleEvent`, which would leave the webhook
 * silently undelivered with nothing in the log to say why. An unsigned delivery
 * is worse than none, so the request is never made.
 */
const prepareAttempt = async (args: { delivery: DeliveryRow }) => {
  const { delivery } = args;

  const webhook = await db.Webhook.findByPk(delivery.webhookId);
  if (!webhook) {
    await abandonDelivery({ delivery, reason: 'Webhook no longer exists.' });
    return null;
  }

  const payload = JSON.stringify(delivery.payload);

  try {
    return {
      webhook,
      payload,
      headers: signatureHeaders({
        payload,
        secret: decryptWebhookSecret(webhook.secret),
      }),
    };
  } catch (error) {
    await abandonDelivery({
      delivery,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

/**
 * Performs exactly one HTTP attempt for an already-persisted delivery, and
 * writes the outcome back to the row. It never loops: the next attempt, if
 * there is one, is a separate claim by whichever process sweeps the row next.
 * That is what lets a delivery survive the process that started it.
 */
const attemptDelivery = async (args: { delivery: DeliveryRow }) => {
  const { delivery } = args;

  const prepared = await prepareAttempt({ delivery });
  if (!prepared) return;

  const { webhook, payload, headers } = prepared;

  const attempt = delivery.attempts + 1;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        'X-Soat-Event': delivery.eventType,
        'X-Soat-Delivery': delivery.publicId,
      },
      body: payload,
      signal: controller.signal,
    });

    const responseBody = await response.text().catch(() => {
      return null;
    });

    if (response.ok) {
      await writeOutcome({
        delivery,
        values: {
          status: 'success',
          attempts: attempt,
          lastAttemptAt: new Date(),
          statusCode: response.status,
          responseBody,
          nextAttemptAt: null,
          leaseExpiresAt: null,
        },
      });
      log(
        'attemptDelivery: delivery=%s succeeded attempt=%d',
        delivery.publicId,
        attempt
      );
      return;
    }

    await recordFailedAttempt({
      delivery,
      attempt,
      statusCode: response.status,
      responseBody,
    });
  } catch (error) {
    await recordFailedAttempt({
      delivery,
      attempt,
      statusCode: null,
      responseBody: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Writes the delivery row for one webhook/event pair. The row exists — with its
 * payload and its due time — before any HTTP call is made, which is the whole
 * point: from here on the delivery is owned by the database, not by whichever
 * process happened to be handling the request that emitted the event.
 *
 * The lease is taken at insert time because the caller attempts it immediately;
 * a concurrent sweep must not pick the same row up for a second, parallel send.
 */
const enqueueDelivery = async (args: {
  webhook: InstanceType<(typeof db)['Webhook']>;
  event: SoatEvent;
}) => {
  const now = new Date();

  // The envelope is a wire payload, so it is snake_case like every other SOAT
  // surface (`.claude/rules/case-convention.md`). `data` stays an opaque value:
  // it is already snake_case because it comes from a lib mapper, and nothing
  // here reads or rewrites a key of it.
  return db.WebhookDelivery.create({
    webhookId: args.webhook.id,
    eventType: args.event.type,
    payload: {
      event: args.event.type,
      project_id: args.event.projectPublicId,
      resource_type: args.event.resourceType,
      resource_id: args.event.resourceId,
      data: args.event.data,
      timestamp: args.event.timestamp,
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
  });
};

const handleEvent = async (event: SoatEvent) => {
  let webhooks;
  try {
    webhooks = await retryTransient({
      label: 'handleEvent.findWebhooks',
      operation: () => {
        return db.Webhook.findAll({
          where: {
            projectId: event.projectId,
            active: true,
          },
        });
      },
    });
  } catch (error) {
    // Was a bare `catch { return }`: a blip on this one read silently unhooked
    // every subscription in the project for that event (#1130).
    recordDroppedEvent({
      stage: 'webhook_lookup',
      type: event.type,
      resourceId: event.resourceId,
      error,
    });
    return;
  }

  for (const webhook of webhooks) {
    if (
      !matchesEvent({
        patterns: webhook.events as string[],
        eventType: event.type,
      })
    ) {
      continue;
    }

    if (webhook.policyId) {
      const allowed = await evaluateEventPolicy({
        policyId: webhook.policyId,
        event,
      });
      if (!allowed) continue;
    }

    // The row write and the first attempt are separated deliberately. They used
    // to share one `.catch()`, which read as "delivery failed" for both — but a
    // failed *attempt* is recorded on the row and retried by the sweep, while a
    // failed *row write* leaves the sweep nothing to find, so the event is gone
    // (#1130). Only the second one is a lost event, and only it is counted.
    void retryTransient({
      label: 'handleEvent.enqueueDelivery',
      operation: () => {
        return enqueueDelivery({ webhook, event });
      },
    })
      .then((delivery) => {
        return attemptDelivery({ delivery }).catch((error: unknown) => {
          // The row exists; its own attempt bookkeeping and the sweep own the
          // retry from here.
          log('handleEvent: first attempt failed for %s %o', event.type, error);
        });
      })
      .catch((error: unknown) => {
        recordDroppedEvent({
          stage: 'delivery_write',
          type: event.type,
          resourceId: event.resourceId,
          error,
        });
      });
  }
};

/**
 * Claims due deliveries and drives one attempt each.
 *
 * This is what makes delivery durable: a row whose attempt was interrupted by a
 * restart keeps its `pending` status and its lease, and is reclaimed here once
 * that lease expires. A row waiting out a backoff is picked up when its
 * `nextAttemptAt` arrives. Neither depends on the process that emitted the
 * event still being alive.
 *
 * Exported for direct testing — unit tests never import `server.ts`, so the
 * interval timer does not exist there and they drive this sweep by hand.
 */
export const sweepDueWebhookDeliveries = createSweep<DeliveryRow>({
  log,
  name: 'sweepDueWebhookDeliveries',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.WebhookDelivery.findAll({
      where: duePredicate({ now }),
      order: [['nextAttemptAt', 'ASC']],
      limit,
    });
  },
  idOf: (delivery) => {
    return delivery.id as number;
  },
  // Atomic claim: taking the lease under the same predicate that selected the
  // row means overlapping ticks, or several server instances, still send each
  // attempt exactly once. Must stay a conditional UPDATE — never read-then-write.
  claim: async ({ row, now }) => {
    const [claimed] = await db.WebhookDelivery.update(
      { leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
      {
        where: {
          id: row.id as number,
          ...duePredicate({ now }),
        },
      }
    );
    return claimed > 0;
  },
  handle: async ({ row }) => {
    await attemptDelivery({ delivery: row });
  },
});

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5_000,
  envVar: 'WEBHOOK_SCHEDULER_INTERVAL_MS',
  disabledEnvVar: 'WEBHOOK_SCHEDULER_DISABLED',
  sweeps: [sweepDueWebhookDeliveries],
});

/**
 * Starts the outbox sweep loop. Called once from `server.ts`; it is the
 * backstop that retries deliveries and recovers ones a restart interrupted.
 */
export const startWebhookScheduler = scheduler.start;

/** Stops the outbox sweep loop (graceful shutdown / test teardown). */
export const stopWebhookScheduler = scheduler.stop;

export const initializeDispatcher = () => {
  // Deliberately unfiltered: a webhook can subscribe to `*`, and to the
  // user-authored names an orchestration `emit_event` node produces, so this
  // dispatcher is the one subscriber that must see every envelope on the bus.
  onEvent({ handler: handleEvent });
};
