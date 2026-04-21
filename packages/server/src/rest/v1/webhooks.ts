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

/**
 * @openapi
 * /projects/{projectId}/webhooks:
 *   get:
 *     tags: [Webhooks]
 *     summary: List webhooks for a project
 *     operationId: listWebhooks
 */
webhooksRouter.get('/projects/:projectId/webhooks', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: ctx.params.projectId,
    action: 'webhooks:ListWebhooks',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: ctx.params.projectId },
  });
  if (!project) {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  ctx.body = await listWebhooks({ projectIds: [project.id] });
});

/**
 * @openapi
 * /projects/{projectId}/webhooks:
 *   post:
 *     tags: [Webhooks]
 *     summary: Create a webhook
 *     operationId: createWebhook
 */
webhooksRouter.post('/projects/:projectId/webhooks', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: ctx.params.projectId,
    action: 'webhooks:CreateWebhook',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: ctx.params.projectId },
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
    const policy = await db.ProjectPolicy.findOne({
      where: { publicId: body.policyId, projectId: project.id },
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

/**
 * @openapi
 * /projects/{projectId}/webhooks/{webhookId}:
 *   get:
 *     tags: [Webhooks]
 *     summary: Get a webhook
 *     operationId: getWebhook
 */
webhooksRouter.get(
  '/projects/:projectId/webhooks/:webhookId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'webhooks:GetWebhook',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhookId });
    if (!webhook || webhook.projectId !== ctx.params.projectId) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    ctx.body = webhook;
  }
);

/**
 * @openapi
 * /projects/{projectId}/webhooks/{webhookId}:
 *   put:
 *     tags: [Webhooks]
 *     summary: Update a webhook
 *     operationId: updateWebhook
 */
webhooksRouter.put(
  '/projects/:projectId/webhooks/:webhookId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'webhooks:UpdateWebhook',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhookId });
    if (!webhook || webhook.projectId !== ctx.params.projectId) {
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
        const project = await db.Project.findOne({
          where: { publicId: ctx.params.projectId },
        });
        const policy = await db.ProjectPolicy.findOne({
          where: { publicId: body.policyId, projectId: project!.id },
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
      id: ctx.params.webhookId,
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

/**
 * @openapi
 * /projects/{projectId}/webhooks/{webhookId}:
 *   delete:
 *     tags: [Webhooks]
 *     summary: Delete a webhook
 *     operationId: deleteWebhook
 */
webhooksRouter.delete(
  '/projects/:projectId/webhooks/:webhookId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'webhooks:DeleteWebhook',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhookId });
    if (!webhook || webhook.projectId !== ctx.params.projectId) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    await deleteWebhook({ id: ctx.params.webhookId });
    ctx.status = 204;
  }
);

/**
 * @openapi
 * /projects/{projectId}/webhooks/{webhookId}/deliveries:
 *   get:
 *     tags: [Webhooks]
 *     summary: List deliveries for a webhook
 *     operationId: listWebhookDeliveries
 */
webhooksRouter.get(
  '/projects/:projectId/webhooks/:webhookId/deliveries',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'webhooks:ListWebhookDeliveries',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhookRecord = await db.Webhook.findOne({
      where: { publicId: ctx.params.webhookId },
      include: [{ model: db.Project, as: 'project' }],
    });

    if (
      !webhookRecord ||
      (webhookRecord as unknown as { project: { publicId: string } }).project
        .publicId !== ctx.params.projectId
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

/**
 * @openapi
 * /projects/{projectId}/webhooks/{webhookId}/deliveries/{deliveryId}:
 *   get:
 *     tags: [Webhooks]
 *     summary: Get a delivery
 *     operationId: getWebhookDelivery
 */
webhooksRouter.get(
  '/projects/:projectId/webhooks/:webhookId/deliveries/:deliveryId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'webhooks:GetWebhookDelivery',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const delivery = await getWebhookDelivery({
      id: ctx.params.deliveryId,
    });
    if (!delivery) {
      ctx.status = 404;
      ctx.body = { error: 'Delivery not found' };
      return;
    }

    ctx.body = delivery;
  }
);

/**
 * @openapi
 * /projects/{projectId}/webhooks/{webhookId}/rotate-secret:
 *   post:
 *     tags: [Webhooks]
 *     summary: Rotate webhook secret
 *     operationId: rotateWebhookSecret
 */
webhooksRouter.post(
  '/projects/:projectId/webhooks/:webhookId/rotate-secret',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'webhooks:RotateWebhookSecret',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const webhook = await getWebhook({ id: ctx.params.webhookId });
    if (!webhook || webhook.projectId !== ctx.params.projectId) {
      ctx.status = 404;
      ctx.body = { error: 'Webhook not found' };
      return;
    }

    const rotated = await rotateWebhookSecret({
      id: ctx.params.webhookId,
    });

    ctx.body = rotated;
  }
);

export { webhooksRouter };
