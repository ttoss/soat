import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  deleteCollectionItem,
  findCollectionItem,
  listCollectionItems,
  patchCollectionItem,
  putCollectionItem,
  updateCollectionItemTags,
} from 'src/lib/collectionItems';
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  updateCollection,
} from 'src/lib/collections';
import { buildSrn } from 'src/lib/iam';
import { emptyPage } from 'src/lib/pagination';
import { readStructuredQuery } from 'src/lib/structuredFilter';
import {
  assertNoSystemTagKeys,
  mergeTags,
  readNullableTagBag,
  readTagQuery,
} from 'src/lib/tags';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  assertItemAllowed,
  collectionAccess,
  type ItemAccess,
  requireCollectionItem,
  requireItemCollection,
} from './collectionItemAccess';
import {
  type AuthenticatedContext,
  parsePagination,
  requireAuth,
  resolveWriteProjectId,
  writePreconditionOf,
} from './helpers';
import { resolveListScope } from './listScope';
import { compileReadPolicy } from './readPolicy';
import { registerTagRoutes } from './tagRoutes';

const collectionsRouter = new Router<Context>();

type CollectionBody = { project_id?: string; name?: unknown; schema?: unknown };
type ItemBody = { data?: unknown; tags?: unknown };

collectionsRouter.get('/collections', async (ctx: Context) => {
  requireAuth(ctx);
  const { projectIds } = await resolveListScope({
    ctx,
    action: 'collections:ListCollections',
    resourceType: 'collection',
    projectSelector: 'optional',
    emptyScope: 'empty',
  });
  ctx.body = await listCollections({ projectIds, ...parsePagination(ctx) });
});

collectionsRouter.post('/collections', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as CollectionBody;
  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'collections:CreateCollection',
    resourceType: 'collection',
  });
  ctx.status = 201;
  ctx.body = await createCollection({
    projectId: Number(projectId),
    name: body.name,
    schema: body.schema,
  });
});

collectionsRouter.get('/collections/:collection_id', async (ctx: Context) => {
  const { projectIds } = await collectionAccess.authorizeRead({
    ctx,
    action: 'collections:GetCollection',
  });
  ctx.body = await getCollection({ id: ctx.params.collection_id, projectIds });
});

collectionsRouter.patch('/collections/:collection_id', async (ctx: Context) => {
  const { projectIds } = await collectionAccess.authorizeWrite({
    ctx,
    action: 'collections:UpdateCollection',
  });
  const body = ctx.request.body as CollectionBody;
  ctx.body = await updateCollection({
    id: ctx.params.collection_id,
    projectIds,
    name: body.name,
    schema: body.schema,
  });
});

collectionsRouter.delete(
  '/collections/:collection_id',
  async (ctx: Context) => {
    const { projectIds, projectPublicId } =
      await collectionAccess.authorizeWrite({
        ctx,
        action: 'collections:DeleteCollection',
      });
    const id: string = ctx.params.collection_id;
    // A `204` has no body for the audit middleware to read the SRN from.
    setAuditResourceHint(ctx, {
      projectPublicId,
      resourceSrn: buildSrn({
        projectPublicId,
        resourceType: 'collection',
        resourceId: id,
      }),
      resourcePublicId: id,
    });
    await deleteCollection({ id, projectIds });
    ctx.status = 204;
  }
);

collectionsRouter.get(
  '/collections/:collection_id/items',
  async (ctx: Context) => {
    requireAuth(ctx);
    const action = 'collections:ListCollectionItems';
    const { collection, access } = await requireItemCollection({
      ctx,
      action,
      access: 'read',
    });
    const data = readStructuredQuery({ name: 'data', query: ctx.query });
    const tags = readTagQuery(ctx.query.tags);
    const { where: policyWhere, hasAccess } = await compileReadPolicy({
      ctx,
      projectPublicId: access.projectPublicId,
      projectIds: undefined,
      action,
      resourceType: 'collection_item',
    });
    if (!hasAccess) {
      ctx.body = emptyPage(parsePagination(ctx));
      return;
    }
    ctx.body = await listCollectionItems({
      collection,
      data,
      tags,
      policyWhere,
      ...parsePagination(ctx),
    });
  }
);

collectionsRouter.get(
  '/collections/:collection_id/items/:key',
  async (ctx: Context) => {
    const { item } = await requireCollectionItem({
      ctx,
      action: 'collections:GetCollectionItem',
      access: 'read',
    });
    ctx.body = item;
  }
);

collectionsRouter.put(
  '/collections/:collection_id/items/:key',
  async (ctx: Context) => {
    requireAuth(ctx);
    const action = 'collections:PutCollectionItem';
    const body = ctx.request.body as ItemBody;
    const tags = assertNoSystemTagKeys(readNullableTagBag(body.tags));
    const { collection, access } = await requireItemCollection({
      ctx,
      action,
      access: 'write',
    });
    const key: string = ctx.params.key;
    const existing = await findCollectionItem({ collection, key });
    await assertItemAllowed({
      ctx,
      projectPublicId: access.projectPublicId,
      action,
      access: 'write',
      key,
      tagBags: [
        ...(existing ? [existing.tags] : []),
        ...(tags !== undefined || !existing ? [tags] : []),
      ],
    });
    const result = await putCollectionItem({
      collection,
      key,
      data: body.data,
      tags,
      expectedVersion: writePreconditionOf(ctx),
    });
    ctx.status = result.created ? 201 : 200;
    ctx.body = result.item;
  }
);

collectionsRouter.patch(
  '/collections/:collection_id/items/:key',
  async (ctx: Context) => {
    const body = ctx.request.body as ItemBody;
    const tags = assertNoSystemTagKeys(readNullableTagBag(body.tags));
    const { collection } = await requireCollectionItem({
      ctx,
      action: 'collections:UpdateCollectionItem',
      access: 'write',
      nextTags: tags,
    });
    ctx.body = await patchCollectionItem({
      collection,
      key: ctx.params.key,
      data: body.data,
      tags,
      expectedVersion: writePreconditionOf(ctx),
    });
  }
);

collectionsRouter.delete(
  '/collections/:collection_id/items/:key',
  async (ctx: Context) => {
    const { collection } = await requireCollectionItem({
      ctx,
      action: 'collections:DeleteCollectionItem',
      access: 'write',
    });
    await deleteCollectionItem({ collection, key: ctx.params.key });
    ctx.status = 204;
  }
);

const resolveItemForTags = async (args: {
  ctx: AuthenticatedContext;
  access: ItemAccess;
}) => {
  const loaded = await requireCollectionItem({
    ctx: args.ctx,
    action:
      args.access === 'read'
        ? 'collections:GetCollectionItem'
        : 'collections:UpdateCollectionItem',
    access: args.access,
  });
  return { ...loaded, ctx: args.ctx };
};

registerTagRoutes({
  router: collectionsRouter,
  path: '/collections/:collection_id/items/:key/tags',
  resolve: resolveItemForTags,
  readTags: async ({ resource }) => {
    return resource.item.tags ?? {};
  },
  writeTags: async ({ resource, tags, merge }) => {
    const next = mergeTags({
      current: resource.item.tags,
      incoming: tags,
      merge,
    });
    await assertItemAllowed({
      ctx: resource.ctx,
      projectPublicId: resource.access.projectPublicId,
      action: 'collections:UpdateCollectionItem',
      access: 'write',
      key: resource.item.key,
      tagBags: [next],
    });
    return updateCollectionItemTags({
      collection: resource.collection,
      key: resource.item.key,
      tags,
      merge,
    });
  },
});

export { collectionsRouter };
