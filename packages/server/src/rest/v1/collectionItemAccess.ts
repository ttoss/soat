import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { findCollectionItem } from 'src/lib/collectionItems';
import { type CollectionRow, collections } from 'src/lib/collections';
import { buildSrn } from 'src/lib/iam';
import { buildResourceTagContext } from 'src/lib/tags';

import { requireAuth } from './helpers';
import {
  makeItemRouteAuthorizer,
  type ResourceAccess,
  resourceRefusal,
} from './resourceAccess';

export type ItemAccess = 'read' | 'write';

export const collectionAccess = makeItemRouteAuthorizer({
  findScope: collections.findScope,
  resourceType: 'collection',
  param: 'collection_id',
  label: 'Collection',
});

/**
 * The collection gate every item route passes first: `action` against the
 * collection's SRN. Returns the row the item lib functions take.
 */
export const requireItemCollection = async (args: {
  ctx: Context;
  action: string;
  access: ItemAccess;
}): Promise<{ collection: CollectionRow; access: ResourceAccess }> => {
  const access =
    args.access === 'read'
      ? await collectionAccess.authorizeRead(args)
      : await collectionAccess.authorizeWrite(args);
  const collection = await collections.getByPublicId({
    id: args.ctx.params.collection_id,
    projectIds: access.projectIds,
  });
  return { collection, access };
};

/**
 * The item gate: `action` against `srn:<project>:collection_item:<key>`, once
 * per tag bag the write touches, so a `iam:ResourceTag/<key>` condition
 * judges both the item as stored and the item as written — a caller cannot
 * move an item into or out of a scope it does not hold.
 */
export const assertItemAllowed = async (args: {
  ctx: Context;
  projectPublicId: string;
  action: string;
  access: ItemAccess;
  key: string;
  tagBags: (Record<string, string> | null | undefined)[];
}): Promise<void> => {
  requireAuth(args.ctx);
  const notFound = new DomainError(
    'RESOURCE_NOT_FOUND',
    `Item '${args.key}' not found.`
  );
  const bags = args.tagBags.length > 0 ? args.tagBags : [null];
  for (const tags of bags) {
    const allowed = await args.ctx.authUser.isAllowed({
      projectPublicId: args.projectPublicId,
      action: args.action,
      resource: buildSrn({
        projectPublicId: args.projectPublicId,
        resourceType: 'collection_item',
        resourceId: args.key,
      }),
      context: buildResourceTagContext({
        resourceType: 'collection_item',
        tags,
      }),
    });
    if (allowed) continue;
    if (args.access === 'read') throw notFound;
    throw await resourceRefusal({
      ctx: args.ctx,
      projectPublicId: args.projectPublicId,
      notFound,
    });
  }
};

/**
 * Both gates for a route on one existing item, plus the bag a write would
 * leave on it. Answers `404` for an item the collection does not hold.
 */
export const requireCollectionItem = async (args: {
  ctx: Context;
  action: string;
  access: ItemAccess;
  /** The bag the write leaves, when it sets one. */
  nextTags?: Record<string, string> | null;
}) => {
  const { collection, access } = await requireItemCollection(args);
  const key: string = args.ctx.params.key;
  const item = await findCollectionItem({ collection, key });
  if (!item) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Item '${key}' not found.`);
  }
  await assertItemAllowed({
    ctx: args.ctx,
    projectPublicId: access.projectPublicId,
    action: args.action,
    access: args.access,
    key,
    tagBags:
      args.nextTags === undefined ? [item.tags] : [item.tags, args.nextTags],
  });
  return { collection, access, item };
};
