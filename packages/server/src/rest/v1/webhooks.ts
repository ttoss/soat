import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  updateWebhook,
} from 'src/lib/webhooks';

const webhooksRouter = new Router<Context>();

webhooksRouter.get('/projects/:project_id/webhooks', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: ctx.params.project_id,
    action: 'webhooks:ListWebhooks',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: ctx.params.project_id },
  });
  if (!project) {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  ctx.body = await listWebhooks({ projectIds: [project.id] });
});

webhooksRouter.post('/projects/:project_id/webhooks', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: ctx.params.project_id,
    action: 'webhooks:CreateWebhook',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: ctx.params.project_id },
  });
  if (!project) {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string;
    url?: string;
    events?: string[];
    policyId?: string;
  };

  if (!body.name || !body.url || !body.events || body.events.length === 0) {
    ctx.status = 400;
    ctx.body = {
      error: 'name, url, and events are required',
    };
    return;
  }

  let policyInternalId: number | null = null;
  if (body.policyId) {
    const policy = await db.Policy.findOne({
      where: { publicId: body.policyId },
    });
    if (!policy) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid policy' };
      return;
    }
    policyInternalId = policy.id;
  }

  const webhook = await createWebhook({
    projectId: project.id,
    policyId: policyInternalId,
    name: body.name,
    description: body.description,
    url: body.url,
    events: body.events,
  });

  ctx.status = 201;
  ctx.body = webhook;
});

webhooksRouter.get(
  '/projects/:project_id/webhooks/:webhook_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.project_id,
      action: 'webhooks:GetWebhook',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhook_id });
    if (!webhook || webhook.projectId !== ctx.params.project_id) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    ctx.body = webhook;
  }
);

webhooksRouter.put(
  '/projects/:project_id/webhooks/:webhook_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.project_id,
      action: 'webhooks:UpdateWebhook',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhook_id });
    if (!webhook || webhook.projectId !== ctx.params.project_id) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
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
      if (body.policyId === null) {
        policyInternalId = null;
      } else {
        const policy = await db.Policy.findOne({
          where: { publicId: body.policyId },
        });
        if (!policy) {
          ctx.status = 400;
          ctx.body = { error: 'Invalid policy' };
          return;
        }
        policyInternalId = policy.id;
      }
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
  }
);

webhooksRouter.delete(
  '/projects/:project_id/webhooks/:webhook_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.project_id,
      action: 'webhooks:DeleteWebhook',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhook_id });
    if (!webhook || webhook.projectId !== ctx.params.project_id) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    await deleteWebhook({ id: ctx.params.webhook_id });
    ctx.status = 204;
  }
);

webhooksRouter.get(
  '/projects/:project_id/webhooks/:webhook_id/deliveries',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.project_id,
      action: 'webhooks:ListWebhookDeliveries',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhookRecord = await db.Webhook.findOne({
      where: { publicId: ctx.params.webhook_id },
      include: [{ model: db.Project, as: 'project' }],
    });

    if (
      !webhookRecord ||
      (webhookRecord as unknown as { project: { publicId: string } }).project
        .publicId !== ctx.params.project_id
    ) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    const limit = ctx.query.limit
      ? parseInt(ctx.query.limit as string, 10)
      : 50;
    const offset = ctx.query.offset
      ? parseInt(ctx.query.offset as string, 10)
      : 0;

    ctx.body = await listWebhookDeliveries({
      webhookId: webhookRecord.id,
      limit,
      offset,
    });
  }
);

webhooksRouter.get(
  '/projects/:project_id/webhooks/:webhook_id/deliveries/:delivery_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.project_id,
      action: 'webhooks:GetWebhookDelivery',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const delivery = await getWebhookDelivery({
      id: ctx.params.delivery_id,
    });
    if (!delivery) {
      ctx.status = 404;
      ctx.body = { error: 'Delivery not found' };
      return;
    }

    ctx.body = delivery;
  }
);

webhooksRouter.post(
  '/projects/:project_id/webhooks/:webhook_id/rotate-secret',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.project_id,
      action: 'webhooks:RotateWebhookSecret',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhook_id });
    if (!webhook || webhook.projectId !== ctx.params.project_id) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    const rotated = await rotateWebhookSecret({
      id: ctx.params.webhook_id,
    });

    ctx.body = rotated;
  }
);

export { webhooksRouter };
