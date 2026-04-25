import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  updateApiKey,
} from 'src/lib/apiKeys';

const apiKeysRouter = new Router<Context>();

/**
 * @openapi
 * /api/v1/api-keys:
 *   post:
 *     tags: [ApiKeys]
 *     summary: Create an API key
 *     security:
 *       - bearerAuth: []
 */
apiKeysRouter.post('/api-keys', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { name, projectId, policyIds } = ctx.request.body as {
    name: string;
    projectId?: string;
    policyIds?: string[];
  };

  if (!name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  let resolvedProjectId: number | undefined;
  if (projectId) {
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    if (!project) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid project' };
      return;
    }
    resolvedProjectId = project.id as number;
  }

  let resolvedPolicyIds: number[] | undefined;
  if (policyIds && policyIds.length > 0) {
    const policies = await db.Policy.findAll({
      where: { publicId: policyIds },
    });
    if (policies.length !== policyIds.length) {
      ctx.status = 400;
      ctx.body = { error: 'One or more invalid policy IDs' };
      return;
    }
    resolvedPolicyIds = policies.map(
      (p: InstanceType<(typeof db)['Policy']>) => p.id as number
    );
  }

  const apiKey = await createApiKey({
    userId: ctx.authUser.id,
    name,
    projectId: resolvedProjectId,
    policyIds: resolvedPolicyIds,
  });

  ctx.status = 201;
  ctx.body = apiKey;
});

/**
 * @openapi
 * /api/v1/api-keys/{id}:
 *   get:
 *     tags: [ApiKeys]
 *     summary: Get an API key
 *     security:
 *       - bearerAuth: []
 */
apiKeysRouter.get('/api-keys/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const apiKey = await getApiKey({ id: ctx.params.id });

  if (!apiKey) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  if (
    apiKey.userId !== ctx.authUser.publicId &&
    ctx.authUser.role !== 'admin'
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = apiKey;
});

/**
 * @openapi
 * /api/v1/api-keys/{id}:
 *   put:
 *     tags: [ApiKeys]
 *     summary: Update an API key
 *     security:
 *       - bearerAuth: []
 */
apiKeysRouter.put('/api-keys/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { name, projectId, policyIds } = ctx.request.body as {
    name?: string;
    projectId?: string | null;
    policyIds?: string[];
  };

  const existing = await getApiKey({ id: ctx.params.id });
  if (!existing) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  if (
    existing.userId !== ctx.authUser.publicId &&
    ctx.authUser.role !== 'admin'
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  let resolvedProjectId: number | null | undefined;
  if (projectId !== undefined) {
    if (projectId === null) {
      resolvedProjectId = null;
    } else {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      if (!project) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid project' };
        return;
      }
      resolvedProjectId = project.id as number;
    }
  }

  let resolvedPolicyIds: number[] | undefined;
  if (policyIds !== undefined) {
    if (policyIds.length === 0) {
      resolvedPolicyIds = [];
    } else {
      const policies = await db.Policy.findAll({
        where: { publicId: policyIds },
      });
      if (policies.length !== policyIds.length) {
        ctx.status = 400;
        ctx.body = { error: 'One or more invalid policy IDs' };
        return;
      }
      resolvedPolicyIds = policies.map(
        (p: InstanceType<(typeof db)['Policy']>) => p.id as number
      );
    }
  }

  const updated = await updateApiKey({
    id: ctx.params.id,
    name,
    projectId: resolvedProjectId,
    policyIds: resolvedPolicyIds,
  });

  ctx.body = updated;
});

/**
 * @openapi
 * /api/v1/api-keys/{id}:
 *   delete:
 *     tags: [ApiKeys]
 *     summary: Delete an API key
 *     security:
 *       - bearerAuth: []
 */
apiKeysRouter.delete('/api-keys/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const existing = await getApiKey({ id: ctx.params.id });
  if (!existing) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  if (
    existing.userId !== ctx.authUser.publicId &&
    ctx.authUser.role !== 'admin'
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteApiKey({ id: ctx.params.id });
  ctx.status = 204;
});

export { apiKeysRouter };
