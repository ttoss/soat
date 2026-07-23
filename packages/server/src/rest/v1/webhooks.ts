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
  rotateWebhookSecret,
  updateWebhook,
} from 'src/lib/webhooks';

import { checkAuth, parsePagination, resolveWriteProjectId } from './helpers';

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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'webhooks:ListWebhooks',
    resourceType: 'webhook',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listWebhooks({
    projectIds: projectIds ?? [],
    ...parsePagination(ctx),
  });
});

webhooksRouter.post('/webhooks', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    name?: string;
    description?: string;
    url?: string;
    events?: string[];
    policyId?: string;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'webhooks:CreateWebhook',
    resourceType: 'webhook',
  });
  if (targetProjectId === null) return;

  if (!body.name || !body.url || !body.events || body.events.length === 0) {
    ctx.status = 400;
    ctx.body = {
      error: 'name, url, and events are required',
    };
    return;
  }

  const policyId = await resolvePolicyId(body.policyId);

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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    ctx.status = 404;
    ctx.body = { error: 'Webhook not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.projectId!,
    action: 'webhooks:GetWebhook',
    resource: buildSrn({
      projectPublicId: webhook.projectId!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = webhook;
});

webhooksRouter.put('/webhooks/:webhook_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    ctx.status = 404;
    ctx.body = { error: 'Webhook not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.projectId!,
    action: 'webhooks:UpdateWebhook',
    resource: buildSrn({
      projectPublicId: webhook.projectId!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string;
    url?: string;
    events?: string[];
    active?: boolean;
    policyId?: string | null;
  };

  let policyInternalId: number | null | undefined;
  if (body.policyId !== undefined) {
    policyInternalId = await resolvePolicyId(body.policyId ?? undefined);
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    ctx.status = 404;
    ctx.body = { error: 'Webhook not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.projectId!,
    action: 'webhooks:DeleteWebhook',
    resource: buildSrn({
      projectPublicId: webhook.projectId!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteWebhook({ id: ctx.params.webhook_id });
  ctx.status = 204;
});

// Webhook deliveries are a top-level resource (/webhook-deliveries) but every
// delivery belongs to a webhook; access is governed by the owning webhook's
// project. Listing requires webhook_id (deliveries have no project of their own).
webhooksRouter.get('/webhook-deliveries', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const webhookPublicId = ctx.query.webhookId as string | undefined;
  if (!webhookPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'webhook_id is required' };
    return;
  }

  const webhook = await getWebhook({ id: webhookPublicId });
  if (!webhook) {
    ctx.status = 404;
    ctx.body = { error: 'Webhook not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.projectId!,
    action: 'webhooks:ListWebhookDeliveries',
    resource: buildSrn({
      projectPublicId: webhook.projectId!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const delivery = await getWebhookDelivery({ id: ctx.params.delivery_id });
  if (!delivery) {
    ctx.status = 404;
    ctx.body = { error: 'Delivery not found' };
    return;
  }

  const webhook = await getWebhook({ id: delivery.webhookId! });
  if (!webhook) {
    ctx.status = 404;
    ctx.body = { error: 'Delivery not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.projectId!,
    action: 'webhooks:GetWebhookDelivery',
    resource: buildSrn({
      projectPublicId: webhook.projectId!,
      resourceType: 'webhook',
      resourceId: webhook.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = delivery;
});

webhooksRouter.get('/webhooks/:webhook_id/secret', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const webhook = await getWebhook({ id: ctx.params.webhook_id });
  if (!webhook) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Webhook not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: webhook.projectId!,
    action: 'webhooks:GetWebhookSecret',
    resource: buildSrn({
      projectPublicId: webhook.projectId!,
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
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhook_id });
    if (!webhook) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: webhook.projectId!,
      action: 'webhooks:RotateWebhookSecret',
      resource: buildSrn({
        projectPublicId: webhook.projectId!,
        resourceType: 'webhook',
        resourceId: webhook.id,
      }),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const rotated = await rotateWebhookSecret({
      id: ctx.params.webhook_id,
    });

    ctx.body = rotated;
  }
);

export { webhooksRouter };
