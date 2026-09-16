import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  createMemoryStore,
  deleteMemoryStore,
  getMemoryStore,
  getMemoryStoreTags,
  listMemoryStores,
  updateMemoryStore,
  updateMemoryStoreTags,
} from 'src/lib/memoryStores';
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

const memoryStoresRouter = new Router<Context>();

type LoadedMemoryStore = NonNullable<
  Awaited<ReturnType<typeof getMemoryStore>>
>;

/**
 * Loads the memory store a request targets and authorizes `action` against it, with
 * the memory store's own tags as the condition context. Shared so a route cannot
 * authorize a memory store without supplying that context — a missing context makes
 * every `soat:ResourceTag/<key>` condition evaluate against nothing, which
 * silently drops a `Deny`.
 */
const requireMemoryStore = async (args: {
  ctx: Context;
  memoryStorePublicId: string;
  action: string;
}): Promise<LoadedMemoryStore> => {
  const memoryStore = await getMemoryStore({ id: args.memoryStorePublicId });
  if (!memoryStore) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory store not found');
  }

  const allowed = await args.ctx.authUser!.isAllowed({
    projectPublicId: memoryStore.project_id!,
    action: args.action,
    resource: buildSrn({
      projectPublicId: memoryStore.project_id!,
      resourceType: 'memory_store',
      resourceId: memoryStore.id,
    }),
    context: buildResourceTagContext({
      resourceType: 'memory_store',
      tags: memoryStore.tags,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return memoryStore;
};

memoryStoresRouter.get('/memory-stores', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const tags = readTagQuery(ctx.query.tags);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'memories:ListMemoryStores',
    resourceType: 'memory_store',
  });

  // Without a single project there is no policy to compile against: the caller
  // spans several, each with its own statements. The listing stays scoped by
  // project, as it was before conditions reached memory stores.
  if (projectPublicId) {
    const policies = await ctx.authUser.getPolicies(projectPublicId);
    const { where: policyWhere, hasAccess } = compilePolicy({
      policies,
      action: 'memories:ListMemoryStores',
      resourceType: 'memory_store',
      projectPublicId,
    });
    ctx.body = await listMemoryStores({
      // No Allow statement matches the action in this project, so the caller
      // reads nothing here — an empty scope, not an error, as on every listing.
      projectIds: hasAccess ? (projectIds ?? []) : [],
      tags,
      policyWhere,
      ...parsePagination(ctx),
    });
    return;
  }

  ctx.body = await listMemoryStores({
    projectIds: projectIds ?? [],
    tags,
    ...parsePagination(ctx),
  });
});

memoryStoresRouter.get(
  '/memory-stores/:memory_store_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    ctx.body = await requireMemoryStore({
      ctx,
      memoryStorePublicId: ctx.params.memory_store_id,
      action: 'memories:GetMemoryStore',
    });
  }
);

memoryStoresRouter.post('/memory-stores', async (ctx: Context) => {
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
    action: 'memories:CreateMemoryStore',
    resourceType: 'memory_store',
  });
  const memoryStore = await createMemoryStore({
    projectId: Number(targetProjectId),
    name: body.name,
    description: body.description,
    tags,
  });

  ctx.status = 201;
  ctx.body = memoryStore;
});

memoryStoresRouter.put(
  '/memory-stores/:memory_store_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    await requireMemoryStore({
      ctx,
      memoryStorePublicId: ctx.params.memory_store_id,
      action: 'memories:UpdateMemoryStore',
    });

    const body = ctx.request.body as {
      name?: string;
      description?: string | null;
      tags?: unknown;
    };

    const updated = await updateMemoryStore({
      id: ctx.params.memory_store_id,
      name: body.name,
      description: body.description,
      tags: readNullableTagBag(body.tags),
    });

    ctx.body = updated;
  }
);

const resolveMemoryStore = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  return requireMemoryStore({
    ctx: args.ctx,
    memoryStorePublicId: args.ctx.params.memory_store_id,
    action:
      args.access === 'read'
        ? 'memories:GetMemoryStore'
        : 'memories:UpdateMemoryStore',
  });
};

registerTagRoutes({
  router: memoryStoresRouter,
  path: '/memory-stores/:memory_store_id/tags',
  resolve: resolveMemoryStore,
  readTags: ({ resource }) => {
    return getMemoryStoreTags({ id: resource.id });
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateMemoryStoreTags({ id: resource.id, tags, merge });
  },
});

memoryStoresRouter.delete(
  '/memory-stores/:memory_store_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    await requireMemoryStore({
      ctx,
      memoryStorePublicId: ctx.params.memory_store_id,
      action: 'memories:DeleteMemoryStore',
    });

    await deleteMemoryStore({ id: ctx.params.memory_store_id });

    ctx.status = 204;
  }
);

export { memoryStoresRouter };
