import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  createMemory,
  deleteMemory,
  getMemory,
  getMemoryTags,
  listMemories,
  updateMemory,
  updateMemoryTags,
} from 'src/lib/memories';
import { compilePolicy } from 'src/lib/policyCompiler';
import {
  buildResourceTagContext,
  readNullableTagBag,
  readTagBag,
  readTagQuery,
} from 'src/lib/tags';

import {
  type AuthenticatedContext,
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { registerTagRoutes, type TagAccess } from './tagRoutes';

const memoriesRouter = new Router<Context>();

type LoadedMemory = NonNullable<Awaited<ReturnType<typeof getMemory>>>;

/**
 * Loads the memory a request targets and authorizes `action` against it, with
 * the memory's own tags as the condition context. Shared so a route cannot
 * authorize a memory without supplying that context — a missing context makes
 * every `soat:ResourceTag/<key>` condition evaluate against nothing, which
 * silently drops a `Deny`.
 */
const requireMemory = async (args: {
  ctx: Context;
  memoryPublicId: string;
  action: string;
}): Promise<LoadedMemory> => {
  const memory = await getMemory({ id: args.memoryPublicId });
  if (!memory) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }

  const allowed = await args.ctx.authUser!.isAllowed({
    projectPublicId: memory.project_id!,
    action: args.action,
    resource: buildSrn({
      projectPublicId: memory.project_id!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
    context: buildResourceTagContext({
      resourceType: 'memory',
      tags: memory.tags,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return memory;
};

memoriesRouter.get('/memories', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const tags = readTagQuery(ctx.query.tags);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'memories:ListMemories',
    resourceType: 'memory',
  });

  // Without a single project there is no policy to compile against: the caller
  // spans several, each with its own statements. The listing stays scoped by
  // project, as it was before conditions reached memories.
  if (projectPublicId) {
    const policies = await ctx.authUser.getPolicies(projectPublicId);
    const { where: policyWhere, hasAccess } = compilePolicy({
      policies,
      action: 'memories:ListMemories',
      resourceType: 'memory',
      projectPublicId,
    });
    ctx.body = await listMemories({
      // No Allow statement matches the action in this project, so the caller
      // reads nothing here — an empty scope, not an error, as on every listing.
      projectIds: hasAccess ? (projectIds ?? []) : [],
      tags,
      policyWhere,
      ...parsePagination(ctx),
    });
    return;
  }

  ctx.body = await listMemories({
    projectIds: projectIds ?? [],
    tags,
    ...parsePagination(ctx),
  });
});

memoriesRouter.get('/memories/:memory_id', async (ctx: Context) => {
  requireAuth(ctx);

  ctx.body = await requireMemory({
    ctx,
    memoryPublicId: ctx.params.memory_id,
    action: 'memories:GetMemory',
  });
});

memoriesRouter.post('/memories', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    name: string;
    description?: string;
    tags?: unknown;
  };

  const tags = readTagBag(body.tags);

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
    tags,
  });

  ctx.status = 201;
  ctx.body = memory;
});

memoriesRouter.put('/memories/:memory_id', async (ctx: Context) => {
  requireAuth(ctx);

  await requireMemory({
    ctx,
    memoryPublicId: ctx.params.memory_id,
    action: 'memories:UpdateMemory',
  });

  const body = ctx.request.body as {
    name?: string;
    description?: string | null;
    tags?: unknown;
  };

  const updated = await updateMemory({
    id: ctx.params.memory_id,
    name: body.name,
    description: body.description,
    tags: readNullableTagBag(body.tags),
  });

  ctx.body = updated;
});

const resolveMemory = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  return requireMemory({
    ctx: args.ctx,
    memoryPublicId: args.ctx.params.memory_id,
    action:
      args.access === 'read' ? 'memories:GetMemory' : 'memories:UpdateMemory',
  });
};

registerTagRoutes({
  router: memoriesRouter,
  path: '/memories/:memory_id/tags',
  resolve: resolveMemory,
  readTags: ({ resource }) => {
    return getMemoryTags({ id: resource.id });
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateMemoryTags({ id: resource.id, tags, merge });
  },
});

memoriesRouter.delete('/memories/:memory_id', async (ctx: Context) => {
  requireAuth(ctx);

  await requireMemory({
    ctx,
    memoryPublicId: ctx.params.memory_id,
    action: 'memories:DeleteMemory',
  });

  await deleteMemory({ id: ctx.params.memory_id });

  ctx.status = 204;
});

export { memoriesRouter };
