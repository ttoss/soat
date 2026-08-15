import { db } from 'src/db';

import { paginatedList } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';
import {
  decryptStoredSecret,
  encryptValue,
  generateSecretValue,
} from './secrets';

const generateSecret = generateSecretValue;

export const decryptWebhookSecret = (stored: string): string => {
  return decryptStoredSecret({ stored, label: 'decryptWebhookSecret' });
};

type WebhookRow = InstanceType<(typeof db)['Webhook']> & {
  project?: InstanceType<(typeof db)['Project']>;
  policy?: InstanceType<(typeof db)['Policy']> | null;
};

const mapWebhook = (
  instance: WebhookRow,
  args?: { includeSecret?: boolean }
) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    policy_id: instance.policy?.publicId ?? null,
    name: instance.name,
    description: instance.description,
    url: instance.url,
    events: instance.events,
    active: instance.active,
    ...(args?.includeSecret
      ? { secret: decryptWebhookSecret(instance.secret) }
      : {}),
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

const webhookIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Policy, as: 'policy' },
  ];
};

const webhooks = makeResourceAccessor<WebhookRow>({
  model: () => {
    return db.Webhook;
  },
  includes: webhookIncludes,
  label: 'Webhook',
});

export const listWebhooks = async (args: {
  projectIds: number[];
  limit?: number;
  offset?: number;
}) => {
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Webhook.findAndCountAll({
        where: { projectId: args.projectIds },
        include: webhookIncludes(),
        distinct: true,
        limit,
        offset,
      });
    },
    map: (w) => {
      return mapWebhook(w);
    },
  });
};

export const getWebhook = async (args: { id: string }) => {
  const webhook = await webhooks.findByPublicId({ id: args.id });
  if (!webhook) return null;
  return mapWebhook(webhook);
};

export const findWebhookSecret = async (args: { id: string }) => {
  const webhook = await db.Webhook.findOne({
    where: { publicId: args.id },
  });
  if (!webhook) return null;
  return { secret: decryptWebhookSecret(webhook.secret as string) };
};

export const createWebhook = async (args: {
  projectId: number;
  policyId?: number | null;
  name: string;
  description?: string;
  url: string;
  events: string[];
}) => {
  const secret = generateSecret();

  const webhook = await db.Webhook.create({
    projectId: args.projectId,
    policyId: args.policyId ?? null,
    name: args.name,
    description: args.description ?? null,
    url: args.url,
    secret: encryptValue(secret),
    events: args.events,
    active: true,
  });

  return mapWebhook(await webhooks.reload(webhook), { includeSecret: true });
};

export const updateWebhook = async (args: {
  id: string;
  name?: string;
  description?: string;
  url?: string;
  events?: string[];
  active?: boolean;
  policyId?: number | null;
}) => {
  const webhook = await db.Webhook.findOne({
    where: { publicId: args.id },
  });
  if (!webhook) return null;

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.description !== undefined) updates.description = args.description;
  if (args.url !== undefined) updates.url = args.url;
  if (args.events !== undefined) updates.events = args.events;
  if (args.active !== undefined) updates.active = args.active;
  if (args.policyId !== undefined) updates.policyId = args.policyId;

  await webhook.update(updates);

  return mapWebhook(await webhooks.reload(webhook));
};

export const deleteWebhook = async (args: { id: string }) => {
  const webhook = await db.Webhook.findOne({
    where: { publicId: args.id },
  });
  if (!webhook) return null;
  await webhook.destroy();
  return true;
};

export const rotateWebhookSecret = async (args: { id: string }) => {
  const webhook = await db.Webhook.findOne({
    where: { publicId: args.id },
  });
  if (!webhook) return null;

  const newSecret = generateSecret();
  await webhook.update({ secret: encryptValue(newSecret) });

  return mapWebhook(await webhooks.reload(webhook), { includeSecret: true });
};

/**
 * The wire projection of a delivery row, shared by the list and single reads so
 * the two cannot drift. `payload` is the event body the subscriber receives —
 * copied as a value, keys untouched.
 */
const mapWebhookDelivery = (
  delivery: InstanceType<typeof db.WebhookDelivery>
) => {
  return {
    id: delivery.publicId,
    webhook_id: (
      delivery as typeof delivery & { webhook?: { publicId: string } }
    ).webhook?.publicId,
    event_type: delivery.eventType,
    payload: delivery.payload,
    status: delivery.status,
    status_code: delivery.statusCode,
    attempts: delivery.attempts,
    last_attempt_at: delivery.lastAttemptAt,
    next_attempt_at: delivery.nextAttemptAt,
    response_body: delivery.responseBody,
    created_at: delivery.createdAt,
    updated_at: delivery.updatedAt,
  };
};

export const listWebhookDeliveries = async (args: {
  webhookId: number;
  limit?: number;
  offset?: number;
}) => {
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.WebhookDelivery.findAndCountAll({
        where: { webhookId: args.webhookId },
        include: [{ model: db.Webhook, as: 'webhook' }],
        distinct: true,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
      });
    },
    map: mapWebhookDelivery,
  });
};

export const getWebhookDelivery = async (args: { id: string }) => {
  const delivery = await db.WebhookDelivery.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Webhook, as: 'webhook' }],
  });
  if (!delivery) return null;
  return mapWebhookDelivery(delivery);
};

/**
 * Queues the stored payload of an existing delivery for another send.
 *
 * It writes a **new** row rather than resetting the original: the original is
 * the record of what happened, and a subscriber auditing why a delivery failed
 * would lose that history if a redelivery overwrote it.
 *
 * The row is left unleased and due immediately, so the outbox sweep claims it
 * on its next tick — the same path every other delivery takes. Nothing is sent
 * from the request's own process, which is what keeps this a `202` with a
 * pollable handle rather than a call that blocks on a subscriber's endpoint.
 */
export const redeliverWebhookDelivery = async (args: { id: string }) => {
  const original = await db.WebhookDelivery.findOne({
    where: { publicId: args.id },
  });
  if (!original) return null;

  const delivery = await db.WebhookDelivery.create({
    webhookId: original.webhookId,
    eventType: original.eventType,
    payload: original.payload,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
    leaseExpiresAt: null,
  });

  const reloaded = await db.WebhookDelivery.findOne({
    where: { id: delivery.id as number },
    include: [{ model: db.Webhook, as: 'webhook' }],
  });

  return mapWebhookDelivery(reloaded!);
};
