import crypto from 'node:crypto';

import { db } from 'src/db';
import { evaluatePolicies, type PolicyDocument } from 'src/lib/iam';

import type { SoatEvent } from './eventBus';
import { onEvent } from './eventBus';
import { decryptWebhookSecret } from './webhooks';

const MAX_ATTEMPTS = 3;
const DELIVERY_TIMEOUT_MS = 10_000;

const signPayload = (args: { payload: string; secret: string }) => {
  return crypto
    .createHmac('sha256', args.secret)
    .update(args.payload)
    .digest('hex');
};

const matchesEvent = (args: {
  patterns: string[];
  eventType: string;
}): boolean => {
  return args.patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern === args.eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return args.eventType.startsWith(prefix + '.');
    }
    return false;
  });
};

const evaluateWebhookPolicy = async (args: {
  policyId: number;
  event: SoatEvent;
}): Promise<boolean> => {
  const policy = await db.Policy.findOne({
    where: { id: args.policyId },
  });
  if (!policy) return false;

  return evaluatePolicies({
    policies: [policy.document as PolicyDocument],
    action: args.event.type,
    resource: `srn:${args.event.projectPublicId}:${args.event.resourceType}:${args.event.resourceId}`,
  });
};

const deliverWebhook = async (args: {
  webhook: InstanceType<(typeof db)['Webhook']>;
  event: SoatEvent;
}) => {
  // The envelope is a wire payload, so it is snake_case like every other SOAT
  // surface (`.claude/rules/case-convention.md`). `data` stays an opaque value:
  // it is already snake_case because it comes from a lib mapper, and nothing
  // here reads or rewrites a key of it.
  const payload = JSON.stringify({
    event: args.event.type,
    project_id: args.event.projectPublicId,
    resource_type: args.event.resourceType,
    resource_id: args.event.resourceId,
    data: args.event.data,
    timestamp: args.event.timestamp,
  });

  const delivery = await db.WebhookDelivery.create({
    webhookId: args.webhook.id,
    eventType: args.event.type,
    payload: JSON.parse(payload),
    status: 'pending',
    attempts: 0,
  });

  // Signing happens after the delivery row exists so that a secret which cannot
  // be decrypted — a row written before secret-at-rest encryption, or a changed
  // `SECRETS_ENCRYPTION_KEY` — is *recorded* rather than thrown past the
  // fire-and-forget `.catch()` in `handleEvent`, which would leave the webhook
  // silently undelivered with nothing in the log to say why. `attempts: 0` and a
  // null `statusCode` mark it as never attempted, so it reads differently from
  // an endpoint that rejected the call.
  let signature: string;
  try {
    signature = signPayload({
      payload,
      secret: decryptWebhookSecret(args.webhook.secret),
    });
  } catch (error) {
    await delivery.update({
      status: 'failed',
      lastAttemptAt: new Date(),
      responseBody: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let lastStatusCode: number | null = null;
  let lastResponseBody: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, DELIVERY_TIMEOUT_MS);

    try {
      const response = await fetch(args.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Soat-Signature': `sha256=${signature}`,
          'X-Soat-Event': args.event.type,
          'X-Soat-Delivery': delivery.publicId,
        },
        body: payload,
        signal: controller.signal,
      });

      lastStatusCode = response.status;
      lastResponseBody = await response.text().catch(() => {
        return null;
      });

      await delivery.update({
        attempts: attempt,
        lastAttemptAt: new Date(),
        statusCode: lastStatusCode,
        responseBody: lastResponseBody,
      });

      if (response.ok) {
        await delivery.update({ status: 'success' });
        return;
      }
    } catch {
      await delivery.update({
        attempts: attempt,
        lastAttemptAt: new Date(),
        statusCode: lastStatusCode,
        responseBody: lastResponseBody,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  await delivery.update({ status: 'failed' });
};

const handleEvent = async (event: SoatEvent) => {
  let webhooks;
  try {
    webhooks = await db.Webhook.findAll({
      where: {
        projectId: event.projectId,
        active: true,
      },
    });
  } catch {
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
      const allowed = await evaluateWebhookPolicy({
        policyId: webhook.policyId,
        event,
      });
      if (!allowed) continue;
    }

    deliverWebhook({ webhook, event }).catch(() => {
      /* delivery failures are recorded in the database */
    });
  }
};

export const initializeDispatcher = () => {
  // Deliberately unfiltered: a webhook can subscribe to `*`, and to the
  // user-authored names an orchestration `emit_event` node produces, so this
  // dispatcher is the one subscriber that must see every envelope on the bus.
  onEvent({ handler: handleEvent });
};
