import crypto from 'node:crypto';

import { db } from 'src/db';
import { evaluatePolicies, type PolicyDocument } from 'src/lib/iam';

import type { SoatEvent } from './eventBus';
import { onEvent } from './eventBus';

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
  const payload = JSON.stringify({
    event: args.event.type,
    projectId: args.event.projectPublicId,
    resourceType: args.event.resourceType,
    resourceId: args.event.resourceId,
    data: args.event.data,
    timestamp: args.event.timestamp,
  });

  const signature = signPayload({
    payload,
    secret: args.webhook.secret,
  });

  const delivery = await db.WebhookDelivery.create({
    webhookId: args.webhook.id,
    eventType: args.event.type,
    payload: JSON.parse(payload),
    status: 'pending',
    attempts: 0,
  });

  let lastStatusCode: number | null = null;
  let lastResponseBody: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, DELIVERY_TIMEOUT_MS);

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

      clearTimeout(timeoutId);

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
  onEvent(handleEvent);
};
