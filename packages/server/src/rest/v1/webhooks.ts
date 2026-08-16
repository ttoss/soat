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

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const resolvePolicyId = async (
  policyPublicId: string | undefined
): Promise<number | null> => {
  if (!policyPublicId) return null;
  const policy = await db.Policy.findOne({
    where: { publicId: policyPublicId },
  });
  if (!policy) {
    throw new DomainError(
      'POLICY_NOT_FOUND',
      `Policy '${policyPublicId}' not found.`
    );
  }
  return policy.id;
};

const webhooksRouter = new Router<Context>();

webhooksRouter.get('/webhooks', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'webhooks:ListWebhooks',
    resourceType: 'webhook',
  });

  ctx.body = await listWebhooks({
    projectIds: projectIds ?? [],
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
    policy_id?: string;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'webhooks:CreateWebhook',
    resourceType: 'webhook',
  });
  if (!body.name || !body.url || !body.events || body.events.length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'name, url, and events are required'
    );
  }

  const policyId = await resolvePolicyId(body.policy_id);

  const webhook = await createWebhook({
    projectId: Number(targetProjectId),
    policyId,
    name: body.name,
    description: body.description,
    url: body.url,
    events: body.events,
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

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.project_id!,
    action: 'webhooks:GetWebhook',
    resource: buildSrn({
      projectPublicId: webhook.project_id!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = webhook;
});

webhooksRouter.put('/webhooks/:webhook_id', async (ctx: Context) => {
  requireAuth(ctx);

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.project_id!,
    action: 'webhooks:UpdateWebhook',
    resource: buildSrn({
      projectPublicId: webhook.project_id!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string;
    url?: string;
    events?: string[];
    active?: boolean;
    policy_id?: string | null;
  };

  let policyInternalId: number | null | undefined;
  if (body.policy_id !== undefined) {
    policyInternalId = await resolvePolicyId(body.policy_id ?? undefined);
  }

  const updated = await updateWebhook({
    id: ctx.params.webhook_id,
    name: body.name,
    description: body.description,
    url: body.url,
    events: body.events,
    active: body.active,
    policyId: policyInternalId,
  });

  ctx.body = updated;
});

webhooksRouter.delete('/webhooks/:webhook_id', async (ctx: Context) => {
  requireAuth(ctx);

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.project_id!,
    action: 'webhooks:DeleteWebhook',
    resource: buildSrn({
      projectPublicId: webhook.project_id!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

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

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.project_id!,
    action: 'webhooks:ListWebhookDeliveries',
    resource: buildSrn({
      projectPublicId: webhook.project_id!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const webhookRecord = await db.Webhook.findOne({
    where: { publicId: webhookPublicId },
  });

  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : 50;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : 0;

  ctx.body = await listWebhookDeliveries({
    webhookId: webhookRecord!.id,
    limit,
    offset,
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

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.project_id!,
    action: 'webhooks:GetWebhookDelivery',
    resource: buildSrn({
      projectPublicId: webhook.project_id!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

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

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: webhook.project_id!,
      action: 'webhooks:RedeliverWebhookDelivery',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

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

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.project_id!,
    action: 'webhooks:GetWebhookSecret',
    resource: buildSrn({
      projectPublicId: webhook.project_id!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

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

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: webhook.project_id!,
      action: 'webhooks:RotateWebhookSecret',
      resource: buildSrn({
        projectPublicId: webhook.project_id!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const rotated = await rotateWebhookSecret({
      id: ctx.params.webhook_id,
    });

    ctx.body = rotated;
  }
);

export { webhooksRouter };
