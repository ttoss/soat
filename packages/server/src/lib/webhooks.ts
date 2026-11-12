import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import {
  type EventFilterArgs,
  storedEventFilter,
  validateEventFilter,
} from './eventMatching';
import { paginatedList } from './pagination';
import { type ProjectScope, projectScopeWhere } from './projectScope';
import { makeResourceAccessor } from './resourceAccessor';
import {
  decryptStoredSecret,
  encryptValue,
  generateSecretValue,
} from './secrets';
import { assertTenantHttpUrl } from './tenantUrl';
import { assertWriterHolds, type Writer } from './writerRule';

const log = createDebug('soat:webhooks');

const generateSecret = generateSecretValue;

export const decryptWebhookSecret = (stored: string): string => {
  return decryptStoredSecret({ stored, label: 'decryptWebhookSecret' });
};

type WebhookRow = InstanceType<(typeof db)['Webhook']> & {
  project?: InstanceType<(typeof db)['Project']>;
};

const mapWebhook = (
  instance: WebhookRow,
  args?: { includeSecret?: boolean }
) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    policy_ids: instance.policyIds ?? [],
    name: instance.name,
    description: instance.description,
    url: instance.url,
    events: instance.events,
    event_resources: instance.eventResources,
    event_data: instance.eventData,
    active: instance.active,
    ...(args?.includeSecret
      ? { secret: decryptWebhookSecret(instance.secret) }
      : {}),
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

const webhookIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const webhooks = makeResourceAccessor<WebhookRow>({
  model: () => {
    return db.Webhook;
  },
  includes: webhookIncludes,
  label: 'Webhook',
});

export const listWebhooks = async (args: {
  projectIds: ProjectScope;
  limit?: number;
  cursor?: string;
}) => {
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { projectIds: args.projectIds },
    where: projectScopeWhere({ projectIds: args.projectIds }),
    order: [['createdAt', 'ASC']],
    query: ({ where, limit, order }) => {
      return db.Webhook.findAll({
        where,
        include: webhookIncludes(),
        order,
        limit,
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

export const createWebhook = async (
  args: EventFilterArgs & {
    projectId: number;
    policyIds?: string[];
    name: string;
    description?: string;
    url: string;
    writer: Writer;
  }
) => {
  log('createWebhook: projectId=%d name=%s', args.projectId, args.name);
  assertTenantHttpUrl({ url: args.url, field: 'url' });
  if (!args.events || args.events.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'events is required.');
  }
  validateEventFilter(args);
  await assertWriterHolds({
    carrier: 'webhooks',
    writer: args.writer,
    projectId: args.projectId,
    carried: { policyIds: args.policyIds ?? [] },
  });

  const secret = generateSecret();

  const webhook = await db.Webhook.create({
    projectId: args.projectId,
    policyIds: args.policyIds,
    name: args.name,
    description: args.description ?? null,
    url: args.url,
    secret: encryptValue(secret),
    ...storedEventFilter(args),
    active: true,
  });

  return mapWebhook(await webhooks.reload(webhook), { includeSecret: true });
};

const UPDATE_FIELDS = [
  'name',
  'description',
  'events',
  'eventResources',
  'eventData',
  'active',
  'policyIds',
] as const;

export const updateWebhook = async (
  args: EventFilterArgs & {
    id: string;
    name?: string;
    description?: string;
    url?: string;
    active?: boolean;
    policyIds?: string[];
    writer: Writer;
  }
) => {
  log('updateWebhook: id=%s', args.id);
  const webhook = await db.Webhook.findOne({
    where: { publicId: args.id },
  });
  if (!webhook) return null;

  if (args.events === null) {
    throw new DomainError('VALIDATION_FAILED', 'events cannot be cleared.');
  }
  validateEventFilter(args);
  await assertWriterHolds({
    carrier: 'webhooks',
    writer: args.writer,
    projectId: webhook.projectId,
    carried: { policyIds: args.policyIds ?? webhook.policyIds },
  });

  const updates: Record<string, unknown> = {};
  for (const field of UPDATE_FIELDS) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  if (args.url !== undefined) {
    assertTenantHttpUrl({ url: args.url, field: 'url' });
    updates.url = args.url;
  }

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
  cursor?: string;
}) => {
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { webhookId: args.webhookId },
    where: { webhookId: args.webhookId },
    order: [['createdAt', 'DESC']],
    query: ({ where, limit, order }) => {
      return db.WebhookDelivery.findAll({
        where,
        include: [{ model: db.Webhook, as: 'webhook' }],
        order,
        limit,
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
    status: 'queued',
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
