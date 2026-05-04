import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  searchMemory,
  updateMemory,
} from 'src/lib/memories';
import type { MemoryConfig } from '@soat/postgresdb';

const memoriesRouter = new Router<Context>();

memoriesRouter.get('/memories', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'memories:ListMemories',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listMemories({ projectIds: projectIds ?? [] });
});

memoriesRouter.get('/memories/:memory_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const memory = await getMemory({ id: ctx.params.memory_id });

  if (!memory) {
    ctx.status = 404;
    ctx.body = { error: 'Memory not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: memory.projectId!,
    action: 'memories:GetMemory',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = memory;
});

memoriesRouter.post('/memories', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    name?: string;
    description?: string;
    config?: MemoryConfig;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  if (!body.config) {
    ctx.status = 400;
    ctx.body = { error: 'config is required' };
    return;
  }

  const { config } = body;
  if (
    !config.search &&
    (!config.paths || config.paths.length === 0) &&
    (!config.documentIds || config.documentIds.length === 0)
  ) {
    ctx.status = 400;
    ctx.body = {
      error:
        'config must include at least one of: search, paths, or documentIds',
    };
    return;
  }

  let resolvedProjectPublicId = body.projectId;
  if (!resolvedProjectPublicId) {
    if (ctx.authUser.apiKeyProjectPublicId) {
      resolvedProjectPublicId = ctx.authUser.apiKeyProjectPublicId;
    } else {
      ctx.status = 400;
      ctx.body = { error: 'projectId is required' };
      return;
    }
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'memories:CreateMemory',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: resolvedProjectPublicId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  const memory = await createMemory({
    projectId: project.id,
    name: body.name,
    description: body.description,
    config: body.config,
  });

  ctx.status = 201;
  ctx.body = memory;
});

memoriesRouter.put('/memories/:memory_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const memory = await getMemory({ id: ctx.params.memory_id });
  if (!memory) {
    ctx.status = 404;
    ctx.body = { error: 'Memory not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: memory.projectId!,
    action: 'memories:UpdateMemory',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string | null;
    config?: MemoryConfig;
  };

  const updated = await updateMemory({
    id: ctx.params.memory_id,
    name: body.name,
    description: body.description,
    config: body.config,
  });

  ctx.body = updated;
});

memoriesRouter.delete('/memories/:memory_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const memory = await getMemory({ id: ctx.params.memory_id });
  if (!memory) {
    ctx.status = 404;
    ctx.body = { error: 'Memory not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: memory.projectId!,
    action: 'memories:DeleteMemory',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteMemory({ id: ctx.params.memory_id });

  ctx.status = 204;
});

memoriesRouter.post('/memories/:memory_id/search', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const memory = await getMemory({ id: ctx.params.memory_id });
  if (!memory) {
    ctx.status = 404;
    ctx.body = { error: 'Memory not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: memory.projectId!,
    action: 'memories:GetMemory',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId: memory.projectId,
    action: 'memories:GetMemory',
  });

  if (!projectIds) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const overrides = ctx.request.body as Partial<MemoryConfig> | undefined;

  const results = await searchMemory({
    id: ctx.params.memory_id,
    projectIds,
    overrides,
  });

  if (results === null) {
    ctx.status = 404;
    ctx.body = { error: 'Memory not found' };
    return;
  }

  ctx.body = { documents: results };
});

export { memoriesRouter };
