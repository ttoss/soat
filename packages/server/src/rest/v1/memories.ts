import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
} from 'src/lib/memories';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const memoriesRouter = new Router<Context>();

memoriesRouter.get('/memories', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const rawTags = ctx.query.tags;
  const tags: string[] | undefined = rawTags
    ? Array.isArray(rawTags)
      ? (rawTags as string[])
      : [rawTags as string]
    : undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'memories:ListMemories',
    resourceType: 'memory',
  });

  ctx.body = await listMemories({
    projectIds: projectIds ?? [],
    tags,
    ...parsePagination(ctx),
  });
});

memoriesRouter.get('/memories/:memory_id', async (ctx: Context) => {
  requireAuth(ctx);

  const memory = await getMemory({ id: ctx.params.memory_id });

  if (!memory) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: memory.project_id!,
    action: 'memories:GetMemory',
    resource: buildSrn({
      projectPublicId: memory.project_id!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = memory;
});

memoriesRouter.post('/memories', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    name: string;
    description?: string;
    tags?: string[];
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'memories:CreateMemory',
    resourceType: 'memory',
  });
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
  requireAuth(ctx);

  const memory = await getMemory({ id: ctx.params.memory_id });
  if (!memory) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: memory.project_id!,
    action: 'memories:UpdateMemory',
    resource: buildSrn({
      projectPublicId: memory.project_id!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
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
  requireAuth(ctx);

  const memory = await getMemory({ id: ctx.params.memory_id });
  if (!memory) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: memory.project_id!,
    action: 'memories:DeleteMemory',
    resource: buildSrn({
      projectPublicId: memory.project_id!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  await deleteMemory({ id: ctx.params.memory_id });

  ctx.status = 204;
});

export { memoriesRouter };
