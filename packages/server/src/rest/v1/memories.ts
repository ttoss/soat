import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
} from 'src/lib/memories';

import { checkAuth, parsePagination, resolveWriteProjectId } from './helpers';

const memoriesRouter = new Router<Context>();

memoriesRouter.get('/memories', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;
  const rawTags = ctx.query.tags;
  const tags: string[] | undefined = rawTags
    ? Array.isArray(rawTags)
      ? (rawTags as string[])
      : [rawTags as string]
    : undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'memories:ListMemories',
    resourceType: 'memory',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listMemories({
    projectIds: projectIds ?? [],
    tags,
    ...parsePagination(ctx),
  });
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
    resource: buildSrn({
      projectPublicId: memory.projectId!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = memory;
});

memoriesRouter.post('/memories', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    name: string;
    description?: string;
    tags?: string[];
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'memories:CreateMemory',
    resourceType: 'memory',
  });
  if (targetProjectId === null) return;

  const memory = await createMemory({
    projectId: Number(targetProjectId),
    name: body.name,
    description: body.description,
    tags: body.tags,
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
    resource: buildSrn({
      projectPublicId: memory.projectId!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string | null;
    tags?: string[] | null;
  };

  const updated = await updateMemory({
    id: ctx.params.memory_id,
    name: body.name,
    description: body.description,
    tags: body.tags,
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
    resource: buildSrn({
      projectPublicId: memory.projectId!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteMemory({ id: ctx.params.memory_id });

  ctx.status = 204;
});

export { memoriesRouter };
