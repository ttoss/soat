import crypto from 'node:crypto';

import { db } from 'src/db';

const generateSecret = () => {
  return crypto.randomBytes(32).toString('hex');
};

const mapWebhook = (
  instance: InstanceType<(typeof db)['Webhook']> & {
    project?: InstanceType<(typeof db)['Project']>;
    policy?: InstanceType<(typeof db)['ProjectPolicy']> | null;
  },
  args?: { includeSecret?: boolean }
) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    policyId: instance.policy?.publicId ?? null,
    name: instance.name,
    description: instance.description,
    url: instance.url,
    events: instance.events,
    active: instance.active,
    ...(args?.includeSecret ? { secret: instance.secret } : {}),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

const webhookIncludes = () => [
  { model: db.Project, as: 'project' },
  { model: db.ProjectPolicy, as: 'policy' },
];

export const listWebhooks = async (args: { projectIds: number[] }) => {
  const webhooks = await db.Webhook.findAll({
    where: { projectId: args.projectIds },
    include: webhookIncludes(),
  });
  return webhooks.map((w) => {
    return mapWebhook(w);
  });
};

export const getWebhook = async (args: { id: string }) => {
  const webhook = await db.Webhook.findOne({
    where: { publicId: args.id },
    include: webhookIncludes(),
  });
  if (!webhook) return null;
  return mapWebhook(webhook);
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
    secret,
    events: args.events,
    active: true,
  });

  const withIncludes = await db.Webhook.findOne({
    where: { id: webhook.id },
    include: webhookIncludes(),
  });

  return mapWebhook(withIncludes!, { includeSecret: true });
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

  const withIncludes = await db.Webhook.findOne({
    where: { id: webhook.id },
    include: webhookIncludes(),
  });

  return mapWebhook(withIncludes!);
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
  await webhook.update({ secret: newSecret });

  const withIncludes = await db.Webhook.findOne({
    where: { id: webhook.id },
    include: webhookIncludes(),
  });

  return mapWebhook(withIncludes!, { includeSecret: true });
};

export const listWebhookDeliveries = async (args: {
  webhookId: number;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const { count, rows } = await db.WebhookDelivery.findAndCountAll({
    where: { webhookId: args.webhookId },
    limit,
    offset,
    order: [['createdAt', 'DESC']],
  });

  return {
    data: rows.map((d) => {
      return {
        id: d.publicId,
        eventType: d.eventType,
        payload: d.payload,
        status: d.status,
        statusCode: d.statusCode,
        attempts: d.attempts,
        lastAttemptAt: d.lastAttemptAt,
        responseBody: d.responseBody,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      };
    }),
    total: count,
    limit,
    offset,
  };
};

export const getWebhookDelivery = async (args: { id: string }) => {
  const delivery = await db.WebhookDelivery.findOne({
    where: { publicId: args.id },
  });
  if (!delivery) return null;
  return {
    id: delivery.publicId,
    eventType: delivery.eventType,
    payload: delivery.payload,
    status: delivery.status,
    statusCode: delivery.statusCode,
    attempts: delivery.attempts,
    lastAttemptAt: delivery.lastAttemptAt,
    responseBody: delivery.responseBody,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
};
