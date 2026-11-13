import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  createWebhook,
  deleteWebhook,
  findWebhookSecret,
  getWebhook,
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhookDelivery,
  rotateWebhookSecret,
  updateWebhook,
} from 'src/lib/webhooks';

import { parsePagination, requireAuth, resolveWriteProjectId } from './helpers';
import { resolveListScope } from './listScope';
import { requireAllowed } from './resourceAccess';

const webhooksRouter = new Router<Context>();

webhooksRouter.get('/webhooks', async (ctx: Context) => {
  requireAuth(ctx);

  const { projectIds } = await resolveListScope({
    ctx,
    action: 'webhooks:ListWebhooks',
    resourceType: 'webhook',
    projectSelector: 'optional',
  });

  ctx.body = await listWebhooks({
    projectIds,
    ...parsePagination(ctx),
  });
});

webhooksRouter.post('/webhooks', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    name?: string;
    description?: string;
    url?: string;
    events?: string[];
    event_resources?: string[];
    event_data?: Record<string, unknown>;
    policy_ids?: string[];
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'webhooks:CreateWebhook',
    resourceType: 'webhook',
  });
  if (!body.name || !body.url) {
    throw new DomainError('VALIDATION_FAILED', 'name and url are required');
  }

  const webhook = await createWebhook({
    projectId: Number(targetProjectId),
    policyIds: body.policy_ids,
    name: body.name,
    description: body.description,
    url: body.url,
    events: body.events,
    eventResources: body.event_resources,
    eventData: body.event_data,
    writer: ctx.authUser,
  });

  ctx.status = 201;
  ctx.body = webhook;
});

webhooksRouter.get('/webhooks/:webhook_id', async (ctx: Context) => {
  requireAuth(ctx);

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: webhook.project_id!,
      action: 'webhooks:GetWebhook',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found'),
  });

  ctx.body = webhook;
});

webhooksRouter.put('/webhooks/:webhook_id', async (ctx: Context) => {
  requireAuth(ctx);

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: webhook.project_id!,
      action: 'webhooks:UpdateWebhook',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found'),
  });

  const body = ctx.request.body as {
    name?: string;
    description?: string;
    url?: string;
    events?: string[];
    event_resources?: string[] | null;
    event_data?: Record<string, unknown> | null;
    active?: boolean;
    policy_ids?: string[];
  };

  const updated = await updateWebhook({
    id: ctx.params.webhook_id,
    name: body.name,
    description: body.description,
    url: body.url,
    events: body.events,
    eventResources: body.event_resources,
    eventData: body.event_data,
    active: body.active,
    policyIds: body.policy_ids,
    writer: ctx.authUser,
  });

  ctx.body = updated;
});

webhooksRouter.delete('/webhooks/:webhook_id', async (ctx: Context) => {
  requireAuth(ctx);

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: webhook.project_id!,
      action: 'webhooks:DeleteWebhook',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found'),
  });

  await deleteWebhook({ id: ctx.params.webhook_id });
  ctx.status = 204;
});

// Webhook deliveries are a top-level resource (/webhook-deliveries) but every
// delivery belongs to a webhook; access is governed by the owning webhook's
// project. Listing requires webhook_id (deliveries have no project of their own).
webhooksRouter.get('/webhook-deliveries', async (ctx: Context) => {
  requireAuth(ctx);

  const webhookPublicId = ctx.query.webhook_id as string | undefined;
  if (!webhookPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'webhook_id is required');
  }

  const webhook = await getWebhook({ id: webhookPublicId });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: webhook.project_id!,
      action: 'webhooks:ListWebhookDeliveries',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found'),
  });

  const webhookRecord = await db.Webhook.findOne({
    where: { publicId: webhookPublicId },
  });

  ctx.body = await listWebhookDeliveries({
    webhookId: webhookRecord!.id,
    ...parsePagination(ctx),
  });
});

webhooksRouter.get('/webhook-deliveries/:delivery_id', async (ctx: Context) => {
  requireAuth(ctx);

  const delivery = await getWebhookDelivery({ id: ctx.params.delivery_id });
  if (!delivery) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Delivery not found');
  }

  const webhook = await getWebhook({ id: delivery.webhook_id! });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Delivery not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: webhook.project_id!,
      action: 'webhooks:GetWebhookDelivery',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'Delivery not found'),
  });

  ctx.body = delivery;
});

// Redelivery re-queues a stored payload; it never sends inline, so the response
// is a `202` carrying the new delivery to poll (`.claude/rules/sync-async.md`).
webhooksRouter.post(
  '/webhook-deliveries/:delivery_id/redeliver',
  async (ctx: Context) => {
    requireAuth(ctx);

    const delivery = await getWebhookDelivery({ id: ctx.params.delivery_id });
    if (!delivery) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Delivery not found');
    }

    const webhook = await getWebhook({ id: delivery.webhook_id! });
    if (!webhook) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Delivery not found');
    }

    await requireAllowed({
      ctx,
      check: {
        projectPublicId: webhook.project_id!,
        action: 'webhooks:RedeliverWebhookDelivery',
        resource: buildSrn({
          projectPublicId: webhook.project_id!,
          resourceType: 'webhook',
          resourceId: webhook.id,
        }),
      },
      notFound: new DomainError('RESOURCE_NOT_FOUND', 'Delivery not found'),
    });

    ctx.status = 202;
    ctx.body = await redeliverWebhookDelivery({ id: ctx.params.delivery_id });
  }
);

webhooksRouter.get('/webhooks/:webhook_id/secret', async (ctx: Context) => {
  requireAuth(ctx);

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: webhook.project_id!,
      action: 'webhooks:GetWebhookSecret',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    },
    notFound: new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found'),
  });

  const secretData = await findWebhookSecret({ id: ctx.params.webhook_id });
  if (!secretData) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }
  ctx.body = secretData;
});

webhooksRouter.post(
  '/webhooks/:webhook_id/rotate-secret',
  async (ctx: Context) => {
    requireAuth(ctx);

    const webhook = await getWebhook({ id: ctx.params.webhook_id });
    if (!webhook) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
    }

    await requireAllowed({
      ctx,
      check: {
        projectPublicId: webhook.project_id!,
        action: 'webhooks:RotateWebhookSecret',
        resource: buildSrn({
          projectPublicId: webhook.project_id!,
          resourceType: 'webhook',
          resourceId: webhook.id,
        }),
      },
      notFound: new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found'),
    });

    const rotated = await rotateWebhookSecret({
      id: ctx.params.webhook_id,
    });

    ctx.body = rotated;
  }
);

export { webhooksRouter };
