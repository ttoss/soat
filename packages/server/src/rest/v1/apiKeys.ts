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
 * Resolves a project public ID to its internal ID
 */
const resolveProjectId = async (args: {
  projectId: string | null | undefined;
}): Promise<{ id: number | undefined; error?: string }> => {
  if (args.projectId === undefined || args.projectId === null) {
    return { id: undefined };
  }

  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return { id: undefined, error: 'Invalid project' };
  }
  return { id: project.id as number };
};

/**
 * Resolves policy public IDs to their internal IDs
 */
const resolvePolicyIds = async (args: {
  policyIds: string[] | undefined;
}): Promise<{ ids: number[] | undefined; error?: string }> => {
  if (args.policyIds === undefined) {
    return { ids: undefined };
  }
  if (args.policyIds.length === 0) {
    return { ids: [] };
  }

  const policies = await db.Policy.findAll({
    where: { publicId: args.policyIds },
  });
  if (policies.length !== args.policyIds.length) {
    return { ids: undefined, error: 'One or more invalid policy IDs' };
  }

  return {
    ids: policies.map((p: InstanceType<(typeof db)['Policy']>) => {
      return p.id as number;
    }),
  };
};

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

  const projectResult = await resolveProjectId({ projectId });
  if (projectResult.error) {
    ctx.status = 400;
    ctx.body = { error: projectResult.error };
    return;
  }

  const policyResult = await resolvePolicyIds({ policyIds });
  if (policyResult.error) {
    ctx.status = 400;
    ctx.body = { error: policyResult.error };
    return;
  }

  const apiKey = await createApiKey({
    userId: ctx.authUser.id,
    name,
    projectId: projectResult.id,
    policyIds: policyResult.ids,
  });

  ctx.status = 201;
  ctx.body = apiKey;
});

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

  const projectResult = await resolveProjectId({ projectId });
  if (projectResult.error) {
    ctx.status = 400;
    ctx.body = { error: projectResult.error };
    return;
  }

  const policyResult = await resolvePolicyIds({ policyIds });
  if (policyResult.error) {
    ctx.status = 400;
    ctx.body = { error: policyResult.error };
    return;
  }

  const updated = await updateApiKey({
    id: ctx.params.id,
    name,
    projectId: projectResult.id,
    policyIds: policyResult.ids,
  });

  ctx.body = updated;
});

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
